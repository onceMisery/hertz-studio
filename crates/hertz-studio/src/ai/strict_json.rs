// SPDX-License-Identifier: MIT

//! Parse before converting untrusted provider text into Value: Value's ordinary
//! deserializer otherwise silently keeps the last occurrence of duplicate keys.

use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::fmt;

pub(super) fn parse(
    bytes: &[u8],
    max_bytes: usize,
    max_depth: usize,
) -> Result<Value, &'static str> {
    if bytes.len() > max_bytes {
        return Err("provider JSON exceeds byte limit");
    }
    let mut parser = serde_json::Deserializer::from_slice(bytes);
    let value = Seed {
        depth: 0,
        max_depth,
    }
    .deserialize(&mut parser)
    .map_err(|_| "provider JSON has invalid structure, depth or duplicate keys")?;
    parser
        .end()
        .map_err(|_| "provider JSON has trailing data")?;
    Ok(value)
}

#[derive(Clone, Copy)]
struct Seed {
    depth: usize,
    max_depth: usize,
}

impl<'de> DeserializeSeed<'de> for Seed {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        if self.depth > self.max_depth {
            return Err(de::Error::custom("JSON depth exceeded"));
        }
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Seed {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("bounded JSON with unique safe keys")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Value, E> {
        Ok(Value::Number(v.into()))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Value, E> {
        Ok(Value::Number(v.into()))
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Value, E> {
        Number::from_f64(v)
            .map(Value::Number)
            .ok_or_else(|| de::Error::custom("nonfinite JSON number"))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Value, E> {
        Ok(Value::String(v.to_owned()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> Result<Value, E> {
        Ok(Value::String(v))
    }
    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        let child = Seed {
            depth: self.depth + 1,
            ..self
        };
        while let Some(value) = seq.next_element_seed(child)? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut values = Map::new();
        let child = Seed {
            depth: self.depth + 1,
            ..self
        };
        while let Some(key) = map.next_key::<String>()? {
            if matches!(key.as_str(), "__proto__" | "prototype" | "constructor")
                || values.contains_key(&key)
            {
                return Err(de::Error::custom("duplicate or dangerous JSON key"));
            }
            values.insert(key, map.next_value_seed(child)?);
        }
        Ok(Value::Object(values))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_ambiguous_or_unsafe_text_before_value_conversion() {
        for text in [
            r#"{"version":1,"version":2}"#,
            r#"{"x":{"a":1,"\u0061":2}}"#,
            r#"{"x":{"__proto__":0}}"#,
            r#"{"x":[{"constructor":0}]}"#,
            r#"{"n":1e999}"#,
            "NaN",
            "{}{}",
            "{} trailing",
            "[1,]",
        ] {
            assert!(parse(text.as_bytes(), 1024, 8).is_err(), "{text}");
        }
        assert!(parse(b"\xff", 1024, 8).is_err());
    }

    #[test]
    fn byte_depth_and_exact_integer_limits_are_independent() {
        assert!(parse(b"{}", 1, 8).is_err());
        assert!(parse(b"[[[0]]]", 100, 2).is_err());
        assert!(parse(b"[[0]]", 100, 2).is_ok());
        assert_eq!(
            parse(b"18446744073709551615", 100, 0).unwrap().as_u64(),
            Some(u64::MAX)
        );
        assert_eq!(
            parse(b"[null,true,-2,0.5,\"text\"]", 100, 1).unwrap(),
            serde_json::json!([null, true, -2, 0.5, "text"])
        );
    }
}
