// SPDX-License-Identifier: MIT
//! Fixed-state projection of the loader's Object.assign({}, extras).pivot.
//! The container's original JSON scanner owns size, depth and duplicate limits.

use std::fmt;

use serde::{
    de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer,
};

#[derive(Default)]
pub(super) struct Extras {
    pub(super) loader_pivot: bool,
}

impl<'de> Deserialize<'de> for Extras {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Self {
            loader_pivot: PivotSeed { prototype: true }.deserialize(deserializer)?,
        })
    }
}

enum Key {
    Pivot,
    Prototype,
    Other,
}
impl<'de> Deserialize<'de> for Key {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct KeyVisitor;
        impl Visitor<'_> for KeyVisitor {
            type Value = Key;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("JSON object key")
            }
            fn visit_str<E>(self, value: &str) -> Result<Key, E> {
                Ok(match value {
                    "pivot" => Key::Pivot,
                    "__proto__" => Key::Prototype,
                    _ => Key::Other,
                })
            }
        }
        deserializer.deserialize_identifier(KeyVisitor)
    }
}

// A JSON.parse carrier's own __proto__ is a data key, so only the outer extras
// may consult its carrier. Neither other nested objects nor arrays propagate.
struct PivotSeed {
    prototype: bool,
}
impl<'de> DeserializeSeed<'de> for PivotSeed {
    type Value = bool;
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<bool, D::Error> {
        deserializer.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for PivotSeed {
    type Value = bool;
    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("any legal JSON extras value")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<bool, A::Error> {
        let mut pivot = false;
        while let Some(key) = map.next_key::<Key>()? {
            match key {
                Key::Pivot => {
                    map.next_value::<IgnoredAny>()?;
                    pivot = true;
                }
                Key::Prototype if self.prototype => {
                    pivot |= map.next_value_seed(PivotSeed { prototype: false })?;
                }
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(pivot)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<bool, A::Error> {
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(false)
    }
    fn visit_bool<E>(self, _: bool) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_i64<E>(self, _: i64) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_u64<E>(self, _: u64) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_f64<E>(self, _: f64) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_str<E>(self, _: &str) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_unit<E>(self) -> Result<bool, E> {
        Ok(false)
    }
}
