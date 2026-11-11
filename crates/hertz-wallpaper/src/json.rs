// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 有界 JSON 预扫描：serde_json 的 Map 会静默吞掉重复键，因此包合同在
//! 结构化解析之前先用字节级扫描器执行两条 §6.1 规则——无重复键、深度 ≤ 上限。
//! 同一个扫描器还负责按字节精确定位顶层键的原始值（catalog 的 registryHash
//! 契约对文件的 scenes 字节段求哈希，见 catalog.rs）。

use std::collections::{BTreeMap, BTreeSet};

use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Number, Value};

use crate::{PackageError, Result};

/// Decode the original JSON bytes without interpreting object keys as serde's
/// private Value carriers. The parser and output tree remain serde_json's;
/// every retained child follows the same literal seed, including from_value.
pub(crate) fn literal_value_from_slice(bytes: &[u8]) -> serde_json::Result<Value> {
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let value = LiteralValueSeed.deserialize(&mut deserializer)?;
    deserializer.end()?;
    Ok(value)
}

pub(crate) fn deserialize_literal_value<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Value, D::Error> {
    LiteralValueSeed.deserialize(deserializer)
}

#[derive(Clone, Copy)]
struct LiteralValueSeed;

impl<'de> DeserializeSeed<'de> for LiteralValueSeed {
    type Value = Value;

    fn deserialize<D: Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<Self::Value, D::Error> {
        deserializer.deserialize_any(LiteralValueVisitor)
    }
}

struct LiteralValueVisitor;

impl<'de> Visitor<'de> for LiteralValueVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("any valid JSON value")
    }

    fn visit_bool<E: serde::de::Error>(self, value: bool) -> std::result::Result<Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E: serde::de::Error>(self, value: i64) -> std::result::Result<Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_i128<E: serde::de::Error>(self, value: i128) -> std::result::Result<Value, E> {
        Number::deserialize(serde::de::value::I128Deserializer::new(value)).map(Value::Number)
    }

    fn visit_u64<E: serde::de::Error>(self, value: u64) -> std::result::Result<Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_u128<E: serde::de::Error>(self, value: u128) -> std::result::Result<Value, E> {
        Number::deserialize(serde::de::value::U128Deserializer::new(value)).map(Value::Number)
    }

    fn visit_f64<E: serde::de::Error>(self, value: f64) -> std::result::Result<Value, E> {
        Ok(Number::from_f64(value).map_or(Value::Null, Value::Number))
    }

    fn visit_str<E: serde::de::Error>(self, value: &str) -> std::result::Result<Value, E> {
        self.visit_string(String::from(value))
    }

    fn visit_string<E: serde::de::Error>(self, value: String) -> std::result::Result<Value, E> {
        Ok(Value::String(value))
    }

    fn visit_none<E: serde::de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_some<D: Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<Value, D::Error> {
        LiteralValueSeed.deserialize(deserializer)
    }

    fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> std::result::Result<Value, A::Error> {
        // Match ValueVisitor: Value arrays do not preallocate from size_hint.
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element_seed(LiteralValueSeed)? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }

    fn visit_map<A: MapAccess<'de>>(self, map: A) -> std::result::Result<Value, A::Error> {
        LiteralMapVisitor.visit_map(map).map(Value::Object)
    }
}

pub(crate) fn deserialize_literal_map<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Map<String, Value>, D::Error> {
    LiteralMapSeed.deserialize(deserializer)
}

#[derive(Clone, Copy)]
struct LiteralMapSeed;

impl<'de> DeserializeSeed<'de> for LiteralMapSeed {
    type Value = Map<String, Value>;

    fn deserialize<D: Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<Self::Value, D::Error> {
        deserializer.deserialize_map(LiteralMapVisitor)
    }
}

struct LiteralMapVisitor;

impl<'de> Visitor<'de> for LiteralMapVisitor {
    type Value = Map<String, Value>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a map")
    }

    fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
        Ok(Map::new())
    }

    fn visit_map<A: MapAccess<'de>>(
        self,
        mut map: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            values.insert(key, map.next_value_seed(LiteralValueSeed)?);
        }
        Ok(values)
    }
}

pub(crate) fn deserialize_literal_btree_map<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<BTreeMap<String, Value>, D::Error> {
    struct LiteralBTreeMapVisitor;

    impl<'de> Visitor<'de> for LiteralBTreeMapVisitor {
        type Value = BTreeMap<String, Value>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a map")
        }

        fn visit_map<A: MapAccess<'de>>(
            self,
            mut map: A,
        ) -> std::result::Result<Self::Value, A::Error> {
            let mut values = BTreeMap::new();
            while let Some(key) = map.next_key::<String>()? {
                values.insert(key, map.next_value_seed(LiteralValueSeed)?);
            }
            Ok(values)
        }
    }

    deserializer.deserialize_map(LiteralBTreeMapVisitor)
}

pub(crate) fn deserialize_literal_values<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Vec<Value>, D::Error> {
    LiteralVecSeed(LiteralValueSeed).deserialize(deserializer)
}

pub(crate) fn deserialize_literal_maps<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Vec<Map<String, Value>>, D::Error> {
    LiteralVecSeed(LiteralMapSeed).deserialize(deserializer)
}

struct LiteralVecSeed<S>(S);

impl<'de, S: DeserializeSeed<'de> + Copy> DeserializeSeed<'de> for LiteralVecSeed<S> {
    type Value = Vec<S::Value>;

    fn deserialize<D: Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<Self::Value, D::Error> {
        deserializer.deserialize_seq(self)
    }
}

impl<'de, S: DeserializeSeed<'de> + Copy> Visitor<'de> for LiteralVecSeed<S> {
    type Value = Vec<S::Value>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a sequence")
    }

    fn visit_seq<A: SeqAccess<'de>>(
        self,
        mut sequence: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        // Match serde's typed Vec cautious(size_hint), including its ZST rule.
        const MAX_PREALLOC_BYTES: usize = 1024 * 1024;
        let capacity = MAX_PREALLOC_BYTES
            .checked_div(std::mem::size_of::<S::Value>())
            .map_or(0, |max| sequence.size_hint().unwrap_or(0).min(max));
        let mut values = Vec::with_capacity(capacity);
        while let Some(value) = sequence.next_element_seed(self.0)? {
            values.push(value);
        }
        Ok(values)
    }
}

pub(crate) fn deserialize_literal_option<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Value>, D::Error> {
    struct LiteralOptionVisitor;

    impl<'de> Visitor<'de> for LiteralOptionVisitor {
        type Value = Option<Value>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("option")
        }

        fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_none<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_some<D: Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> std::result::Result<Self::Value, D::Error> {
            LiteralValueSeed.deserialize(deserializer).map(Some)
        }

        fn __private_visit_untagged_option<D: Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> std::result::Result<Self::Value, ()> {
            Ok(LiteralValueSeed.deserialize(deserializer).ok())
        }
    }

    deserializer.deserialize_option(LiteralOptionVisitor)
}

/// 校验 UTF-8 JSON 字节：对象键不得重复，嵌套深度不得超过 `max_depth`。
/// 字符串内的引号/转义按 RFC 8259 处理；不校验数值合法性（交给 serde）。
pub fn check_bounded_json(bytes: &[u8], max_depth: usize) -> Result<()> {
    let mut scanner = Scanner::new(bytes);
    scanner.skip_ws();
    scanner.check_value(0, max_depth)?;
    scanner.skip_ws();
    if scanner.pos != bytes.len() {
        return Err(scanner.err("trailing_bytes", "JSON 值之后存在多余字节"));
    }
    Ok(())
}

/// Visit every scalar without retaining a Value tree. serde's IgnoredAny can
/// skip an out-of-range numeric token in an unknown field; model metadata must
/// remain finite even when only a small header is extracted afterwards.
pub fn check_finite_json_values(bytes: &[u8]) -> Result<()> {
    serde_json::from_slice::<FiniteValue>(bytes)
        .map(|_| ())
        .map_err(|error| PackageError::new("invalid_json", error.to_string()))
}

struct FiniteValue;
impl<'de> serde::Deserialize<'de> for FiniteValue {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        deserializer.deserialize_any(FiniteVisitor)
    }
}
struct FiniteVisitor;
impl<'de> serde::de::Visitor<'de> for FiniteVisitor {
    type Value = FiniteValue;
    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("JSON containing only finite numbers")
    }
    fn visit_bool<E: serde::de::Error>(self, _: bool) -> std::result::Result<Self::Value, E> {
        Ok(FiniteValue)
    }
    fn visit_i64<E: serde::de::Error>(self, _: i64) -> std::result::Result<Self::Value, E> {
        Ok(FiniteValue)
    }
    fn visit_u64<E: serde::de::Error>(self, _: u64) -> std::result::Result<Self::Value, E> {
        Ok(FiniteValue)
    }
    fn visit_f64<E: serde::de::Error>(self, value: f64) -> std::result::Result<Self::Value, E> {
        if value.is_finite() {
            Ok(FiniteValue)
        } else {
            Err(E::custom("non-finite JSON number"))
        }
    }
    fn visit_str<E: serde::de::Error>(self, _: &str) -> std::result::Result<Self::Value, E> {
        Ok(FiniteValue)
    }
    fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
        Ok(FiniteValue)
    }
    fn visit_seq<A: serde::de::SeqAccess<'de>>(
        self,
        mut sequence: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        while sequence.next_element::<FiniteValue>()?.is_some() {}
        Ok(FiniteValue)
    }
    fn visit_map<A: serde::de::MapAccess<'de>>(
        self,
        mut map: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        while map.next_key::<serde::de::IgnoredAny>()?.is_some() {
            map.next_value::<FiniteValue>()?;
        }
        Ok(FiniteValue)
    }
}

/// 返回顶层 `key` 对应值的原始字节区间（不含包裹空白）。
/// 只在顶层（深度 1 的对象成员）查找；找不到返回 None。
pub fn top_level_raw_value(bytes: &[u8], key: &str) -> Option<std::ops::Range<usize>> {
    let mut scanner = Scanner::new(bytes);
    scanner.skip_ws();
    if scanner.peek() != Some(b'{') {
        return None;
    }
    scanner.pos += 1;
    scanner.skip_ws();
    if scanner.peek() == Some(b'}') {
        return None;
    }
    loop {
        scanner.skip_ws();
        let matched = scanner.read_key()? == key;
        scanner.skip_ws();
        if scanner.peek() != Some(b':') {
            return None;
        }
        scanner.pos += 1;
        scanner.skip_ws();
        let value_range = scanner.raw_value_range()?;
        if matched {
            return Some(value_range);
        }
        scanner.skip_ws();
        match scanner.peek() {
            Some(b',') => {
                scanner.pos += 1;
            }
            Some(b'}') => return None,
            _ => return None,
        }
    }
}

struct Scanner<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Scanner<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    fn err(&self, code: &'static str, message: impl Into<String>) -> PackageError {
        PackageError::new(code, format!("{}（字节偏移 {}）", message.into(), self.pos))
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    /// 读取一个 JSON 字符串字面量（含引号），返回区间。假定输入已完成 UTF-8
    /// 校验的调用方在此之外处理编码；这里只保证结构正确。
    fn read_string(&mut self) -> Option<std::ops::Range<usize>> {
        if self.peek() != Some(b'"') {
            return None;
        }
        let start = self.pos;
        self.pos += 1;
        loop {
            match self.peek() {
                None => return None,
                Some(b'"') => {
                    self.pos += 1;
                    return Some(start..self.pos);
                }
                Some(b'\\') => {
                    self.pos += 2;
                }
                Some(_) => self.pos += 1,
            }
        }
    }

    /// Keys have the same decoded identity as serde's object maps. Keep their
    /// original span separate so locating values never rewrites source bytes.
    fn read_key(&mut self) -> Option<String> {
        let range = self.read_string()?;
        serde_json::from_slice(&self.bytes[range]).ok()
    }

    /// 读取任意 JSON 值的原始字节区间（不递归校验；校验走 check_value）。
    fn raw_value_range(&mut self) -> Option<std::ops::Range<usize>> {
        let start = self.pos;
        self.skip_value()?;
        Some(start..self.pos)
    }

    fn check_value(&mut self, depth: usize, max_depth: usize) -> Result<()> {
        if depth > max_depth {
            return Err(self.err("manifest_depth", format!("JSON 嵌套深度超过 {max_depth}")));
        }
        match self.peek() {
            Some(b'{') => self.check_object(depth, max_depth),
            Some(b'[') => self.check_array(depth, max_depth),
            Some(b'"') => self
                .read_string()
                .ok_or_else(|| self.err("invalid_json", "字符串未闭合"))
                .map(|_| ()),
            Some(b't' | b'f' | b'n') => {
                for literal in [b"true".as_slice(), b"false".as_slice(), b"null".as_slice()] {
                    if self.bytes[self.pos..].starts_with(literal) {
                        self.pos += literal.len();
                        return Ok(());
                    }
                }
                Err(self.err("invalid_json", "非法字面量"))
            }
            Some(byte) if byte == b'-' || byte.is_ascii_digit() => {
                while matches!(self.peek(), Some(byte) if byte == b'-' || byte == b'+' || byte == b'.' || byte == b'e' || byte == b'E' || byte.is_ascii_digit())
                {
                    self.pos += 1;
                }
                Ok(())
            }
            _ => Err(self.err("invalid_json", "期望 JSON 值")),
        }
    }

    fn check_object(&mut self, depth: usize, max_depth: usize) -> Result<()> {
        self.pos += 1; // '{'
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(());
        }
        let mut seen = BTreeSet::new();
        loop {
            self.skip_ws();
            let key = self
                .read_key()
                .ok_or_else(|| self.err("invalid_json", "对象键必须是字符串"))?;
            if seen.contains(&key) {
                return Err(self.err("duplicate_key", format!("对象存在重复键「{key}」")));
            }
            seen.insert(key);
            self.skip_ws();
            if self.peek() != Some(b':') {
                return Err(self.err("invalid_json", "对象键后缺少冒号"));
            }
            self.pos += 1;
            self.skip_ws();
            self.check_value(depth + 1, max_depth)?;
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(());
                }
                _ => return Err(self.err("invalid_json", "对象成员后缺少逗号或右括号")),
            }
        }
    }

    fn check_array(&mut self, depth: usize, max_depth: usize) -> Result<()> {
        self.pos += 1; // '['
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(());
        }
        loop {
            self.skip_ws();
            self.check_value(depth + 1, max_depth)?;
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b']') => {
                    self.pos += 1;
                    return Ok(());
                }
                _ => return Err(self.err("invalid_json", "数组元素后缺少逗号或右括号")),
            }
        }
    }

    /// 跳过任意 JSON 值（结构感知但不做语义校验），供 raw_value_range 使用。
    fn skip_value(&mut self) -> Option<()> {
        match self.peek()? {
            b'{' | b'[' => {
                let open = self.peek()?;
                let close = if open == b'{' { b'}' } else { b']' };
                let mut depth = 0usize;
                loop {
                    match self.peek()? {
                        b'"' => {
                            self.read_string()?;
                        }
                        byte if byte == open => {
                            depth += 1;
                            self.pos += 1;
                        }
                        byte if byte == close => {
                            depth -= 1;
                            self.pos += 1;
                            if depth == 0 {
                                return Some(());
                            }
                        }
                        _ => self.pos += 1,
                    }
                }
            }
            b'"' => {
                self.read_string()?;
                Some(())
            }
            _ => {
                while matches!(self.peek(), Some(byte) if !byte.is_ascii_whitespace() && !matches!(byte, b',' | b']' | b'}'))
                {
                    self.pos += 1;
                }
                Some(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_keys_are_rejected_at_any_depth() {
        assert!(check_bounded_json(br#"{"a":1,"b":2}"#, 16).is_ok());
        let nested = br#"{"a":{"b":[1,{"c":1,"c":2}]}}"#;
        let error = check_bounded_json(nested, 16).unwrap_err();
        assert_eq!(error.code, "duplicate_key");
        // 字符串里的引号/转义不参与结构。
        assert!(check_bounded_json(br#"{"a":"x\"y","b":"}"}"#, 16).is_ok());
    }

    #[test]
    fn decoded_key_aliases_are_rejected_without_collapsing_distinct_keys() {
        for bytes in [
            br#"{"opacity":0.1,"\u006fpacity":0.9}"#.as_slice(),
            br#"{"\u006fpacity":1,"\u006F\u0070acity":2}"#,
            br#"{"\\u006fpacity":1,"\u005cu006fpacity":2}"#,
            br#"{"a/b":1,"a\/b":2}"#,
            br#"{"\n":1,"\u000a":2}"#,
            "{\"透明度\":1,\"\\u900f\\u660e\\u5ea6\":2}".as_bytes(),
            "{\"🙂\":1,\"\\ud83d\\ude42\":2}".as_bytes(),
        ] {
            assert_eq!(
                check_bounded_json(bytes, 16).unwrap_err().code,
                "duplicate_key"
            );
        }
        for bytes in [
            br#"{"opacity":1,"\\u006fpacity":2}"#.as_slice(),
            br#"{"a/b":1,"a\\/b":2}"#,
            "{\"🙂\":1,\"\\ud83d\\ude43\":2}".as_bytes(),
        ] {
            check_bounded_json(bytes, 16).unwrap();
        }
        for bytes in [br#"{"\ud83d":1}"#.as_slice(), br#"{"\q":1}"#] {
            assert_eq!(
                check_bounded_json(bytes, 16).unwrap_err().code,
                "invalid_json"
            );
        }
    }

    #[test]
    fn depth_limit_is_enforced() {
        let deep = "[[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]]";
        assert!(check_bounded_json(deep.as_bytes(), 17).is_ok());
        assert_eq!(
            check_bounded_json(deep.as_bytes(), 16).unwrap_err().code,
            "manifest_depth"
        );
    }

    #[test]
    fn top_level_raw_value_is_byte_exact() {
        let bytes = br#"{"a":1,"scenes":[{"id":"zodiac"},{"id":"coast"}],"b":2}"#;
        let range = top_level_raw_value(bytes, "scenes").unwrap();
        assert_eq!(
            &bytes[range.start..range.end],
            br#"[{"id":"zodiac"},{"id":"coast"}]"#
        );
        assert!(top_level_raw_value(bytes, "missing").is_none());
        // 字符串值里的花括号不影响定位。
        let tricky = br#"{"scenes":"}{","x":{"scenes":false}}"#;
        let range = top_level_raw_value(tricky, "scenes").unwrap();
        assert_eq!(&tricky[range.start..range.end], br#""}{""#);
        let escaped = br#"{"\\u0073cenes":false,"\u0073cenes": [ {"id":"zodiac"} ] }"#;
        let range = top_level_raw_value(escaped, "scenes").unwrap();
        assert_eq!(&escaped[range], br#"[ {"id":"zodiac"} ]"#);
        let unicode = "{\"\\ud83d\\ude42\": { \"value\": 1 }}";
        let range = top_level_raw_value(unicode.as_bytes(), "🙂").unwrap();
        assert_eq!(&unicode.as_bytes()[range], br#"{ "value": 1 }"#);
    }
}
