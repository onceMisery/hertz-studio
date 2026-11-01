// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 有界 JSON 预扫描：serde_json 的 Map 会静默吞掉重复键，因此包合同在
//! 结构化解析之前先用字节级扫描器执行两条 §6.1 规则——无重复键、深度 ≤ 上限。
//! 同一个扫描器还负责按字节精确定位顶层键的原始值（catalog 的 registryHash
//! 契约对文件的 scenes 字节段求哈希，见 catalog.rs）。

use crate::{PackageError, Result};

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
        let key_range = scanner.read_string()?;
        let matched = bytes
            .get(key_range.start + 1..key_range.end - 1)
            .map(|raw| raw == key.as_bytes())
            .unwrap_or(false);
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
            Some(b'"') => {
                self.read_string()
                    .ok_or_else(|| self.err("invalid_json", "字符串未闭合"))
                    .map(|_| ())
            }
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
        let mut seen: Vec<&[u8]> = Vec::new();
        loop {
            self.skip_ws();
            let key = self
                .read_string()
                .ok_or_else(|| self.err("invalid_json", "对象键必须是字符串"))?;
            let key_bytes = &self.bytes[key.start + 1..key.end - 1];
            if seen.contains(&key_bytes) {
                let key_text = String::from_utf8_lossy(key_bytes);
                return Err(self.err("duplicate_key", format!("对象存在重复键「{key_text}」")));
            }
            seen.push(key_bytes);
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
        assert_eq!(&bytes[range.start..range.end], br#"[{"id":"zodiac"},{"id":"coast"}]"#);
        assert!(top_level_raw_value(bytes, "missing").is_none());
        // 字符串值里的花括号不影响定位。
        let tricky = br#"{"scenes":"}{","x":{"scenes":false}}"#;
        let range = top_level_raw_value(tricky, "scenes").unwrap();
        assert_eq!(&tricky[range.start..range.end], br#""}{""#);
    }
}
