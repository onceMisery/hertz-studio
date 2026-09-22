// SPDX-License-Identifier: MIT

//! 平台请求签名工具。只实现平台客户端自身使用的公开摘要算法（MD5/SHA1），
//! 不涉及任何加密音频解密。

// md-5 与 sha1 都 re-export 同一个 digest::Digest trait，方法解析按 trait 身份
// 进行，一个名字进作用域即可，两边的 update/finalize 都能解析。
use md5::{Digest as _, Md5};
use sha1::Sha1;

pub fn md5_hex(input: &[u8]) -> String {
    let mut h = Md5::new();
    h.update(input);
    hex_lower(&h.finalize())
}

pub fn sha1_hex(input: &[u8]) -> String {
    let mut h = Sha1::new();
    h.update(input);
    hex_lower(&h.finalize())
}

/// 手写十六进制编码，不引 hex crate。
pub fn hex_lower(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(H[(b >> 4) as usize] as char);
        out.push(H[(b & 0x0f) as usize] as char);
    }
    out
}

/// 酷狗公共参数签名（盐值与拼接形态）。
pub mod kugou {
    use super::md5_hex;
    use std::collections::BTreeMap;

    // Task 22 真机验收备用：现有四跳回退不含安卓通道；若真机移动通道被限，
    // 用它补安卓签名跳，验收后仍无消费则随函数一起删除。
    #[allow(dead_code)]
    pub const ANDROID_SALT: &str = "OIlwieks28dk2k092lksi2UIkp";
    pub const H5_SALT: &str = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
    pub const SIGN_KEY_SALT: &str = "57ae12eb6890223e355ccfcb74edf70d";

    /// 按键名排序后把 k=v 无分隔拼接。BTreeMap 保证顺序确定。
    fn sorted_kv(params: &BTreeMap<String, String>) -> String {
        params
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("")
    }

    /// md5(SALT + sorted(k=v) + body + SALT)
    #[allow(dead_code)] // 见 ANDROID_SALT：Task 22 真机验收决定启用或删除
    pub fn android_sign(params: &BTreeMap<String, String>, body: &str) -> String {
        md5_hex(format!("{ANDROID_SALT}{}{body}{ANDROID_SALT}", sorted_kv(params)).as_bytes())
    }

    /// md5(SALT + sorted(k=v) [+ body_json] + SALT)
    pub fn h5_sign(params: &BTreeMap<String, String>, body_json: Option<&str>) -> String {
        let core = sorted_kv(params) + body_json.unwrap_or("");
        md5_hex(format!("{H5_SALT}{core}{H5_SALT}").as_bytes())
    }

    /// md5(lower(hash) + SIGN_KEY_SALT + appid + mid + userid)
    pub fn play_key(hash: &str, mid: &str, userid: &str, appid: &str) -> String {
        md5_hex(
            format!(
                "{hash}{salt}{appid}{mid}{userid}",
                hash = hash.to_lowercase(),
                salt = SIGN_KEY_SALT,
                appid = appid,
                mid = mid,
                userid = userid
            )
            .as_bytes(),
        )
    }

    /// 移动版 playInfo 的 key：md5(hash + "kgcloud")
    pub fn mobile_key(hash: &str) -> String {
        md5_hex(format!("{hash}kgcloud").as_bytes())
    }
}

/// 酷狗网页扫码「token 换票据」的载荷加密（login-user.kugou.com v2 流程）。
///
/// 这是酷狗网页登录 JS（kguser.v2）自身使用的公开算法，不涉及音频/DRM：
/// 随机 16 字符 AES-128-CBC 密钥（IV 与 key 相同）加密 `{token}`，再用
/// 1024 位 RSA（e=65537，NoPadding 大端右对齐）加密 `{clienttime_ms,key}`。
pub mod kugou_login {
    use aes::cipher::block_padding::Pkcs7;
    use aes::Aes128;
    use cbc::cipher::{BlockEncryptMut, KeyIvInit};
    use num_bigint::BigUint;
    use uuid::Uuid;

    /// 酷狗登录 JS 内置的 1024 位 RSA 模数（公开常量，非密钥）。
    const RSA_MODULUS_HEX: &str =
        "B1B1EC76A1BBDBF0D18E8CD9A87E53FA3881E2F004C67C9DDA2CA677DBEFA3D61DF8463FE12D84FF4B4699E\
02C9D41CAB917F5A8FB9E35580C4BDF97763A0420A476295D763EE10174E6F9EBF7DF8A77BA5B20CDA4EE705DEF5\
BBA3C88567B9656E52C9CD5CD95CA735FF2D25F762B133273EEEB7B4F3EA8B6DA29040F3B67CD";
    const RSA_EXPONENT: u32 = 65537;
    /// 模数字节数：1024 位 = 128 字节。
    const RSA_BLOCK: usize = 128;
    const KEY_ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    /// 生成 16 字符随机 AES 密钥（字符集与长度与网页 JS 一致；一个 u128
    /// 的熵远超 36^16，逐位模 36 不构成实际偏置问题）。
    pub fn random_key() -> String {
        let mut x = Uuid::new_v4().as_u128();
        let mut out = Vec::with_capacity(16);
        for _ in 0..16 {
            out.push(KEY_ALPHABET[(x % 36) as usize]);
            x /= 36;
        }
        // SAFETY: 全部取自 ASCII 字母数字。
        String::from_utf8(out).unwrap()
    }

    /// AES-128-CBC/Pkcs7，IV 与 key 相同（网页 JS 行为），返回标准 base64。
    pub fn aes_encrypt(plaintext: &str, key: &str) -> String {
        let enc = cbc::Encryptor::<Aes128>::new_from_slices(key.as_bytes(), key.as_bytes())
            .expect("AES key/iv 恒为 16 字节");
        let ciphertext = enc.encrypt_padded_vec_mut::<Pkcs7>(plaintext.as_bytes());
        super::qq::b64_encode_std(&ciphertext)
    }

    /// 酷狗 NoPadding RSA：明文 UTF-8 大端右对齐进 128 字节块，做教科书
    /// m^e mod n，输出小写 hex（与网页 JS 的 S(d) 一致，前导零自然丢弃）。
    pub fn rsa_encrypt(plaintext: &str) -> String {
        let bytes = plaintext.as_bytes();
        debug_assert!(bytes.len() <= RSA_BLOCK);
        let mut block = vec![0u8; RSA_BLOCK];
        block[RSA_BLOCK - bytes.len()..].copy_from_slice(bytes);
        let m = BigUint::from_bytes_be(&block);
        let n = BigUint::parse_bytes(RSA_MODULUS_HEX.as_bytes(), 16).expect("模数是合法 hex");
        let c = m.modpow(&BigUint::from(RSA_EXPONENT), &n);
        super::hex_lower(&c.to_bytes_be())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn random_key_is_16_chars_from_alphabet() {
            let k = random_key();
            assert_eq!(k.len(), 16);
            assert!(k.bytes().all(|b| KEY_ALPHABET.contains(&b)));
            assert_ne!(random_key(), random_key());
        }

        #[test]
        fn aes_known_vector_roundtrip_shape() {
            // 不引解密侧依赖：只校验输出形态稳定（base64、长度为块大小倍数）。
            let key = "0123456789ABCDEF";
            let ct = aes_encrypt("{\"token\":\"abc\"}", key);
            // 明文 15 字节 + Pkcs7 补到 16 字节 = 一个块 = 24 字符 base64。
            assert_eq!(ct.len(), 24);
        }

        #[test]
        fn rsa_block_is_right_aligned_and_deterministic() {
            let a = rsa_encrypt("{}");
            let b = rsa_encrypt("{}");
            assert_eq!(a, b);
            // 模 1024 位的密文 hex 不超过 256 字符；2 字节明文结果通常占满。
            assert!(a.len() <= 256 && a.len() > 200);
            // 不同明文必须产生不同密文。
            assert_ne!(rsa_encrypt("{}"), rsa_encrypt("{\"x\":1}"));
        }
    }
}

/// QQ 音乐 musics.fcg 搜索签名（"zzc" 算法）与扫码 ptqrtoken。
pub mod qq {
    use super::sha1_hex;

    const SCRAMBLE: [u8; 20] = [
        89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121,
        179,
    ];
    const PART1: [usize; 8] = [23, 14, 6, 36, 16, 40, 7, 19];
    const PART2: [usize; 8] = [16, 1, 32, 12, 19, 27, 8, 5];

    /// ptqrlogin 的 ptqrtoken：h=0；逐字符 h += (h<<5) + c；最后 &0x7fffffff。
    /// qrsig 恒为 ASCII cookie，按字节迭代等价于 JS 参考实现里的 charCodeAt。
    pub fn gtk33(qrsig: &str) -> u64 {
        let mut h: u64 = 0;
        for c in qrsig.bytes() {
            h = h.wrapping_add(h << 5).wrapping_add(c as u64);
        }
        h & 0x7fff_ffff
    }

    /// QQ 网页接口的 g_tk：与 gtk33 同形，只是初始值为 5381（DJB2）。
    /// 扫码授权链用 p_skey 求 g_tk；匿名 CGI 无凭据时直接传字面量 5381。
    pub fn gtk5381(key: &str) -> u64 {
        let mut h: u64 = 5381;
        for c in key.bytes() {
            h = h.wrapping_add(h << 5).wrapping_add(c as u64);
        }
        h & 0x7fff_ffff
    }

    pub fn zzc_sign(body: &str) -> String {
        let hash = sha1_hex(body.as_bytes());
        let chars: Vec<char> = hash.chars().collect();
        let pick = |idxs: &[usize]| {
            idxs.iter()
                // 参考实现的位置是 1 基（含位置 40），转成 0 基索引。
                .map(|i| chars[i - 1])
                .collect::<String>()
        };
        let part1 = pick(&PART1);
        let part2 = pick(&PART2);

        let mut xored = Vec::with_capacity(20);
        for (i, &k) in SCRAMBLE.iter().enumerate() {
            let byte = u8::from_str_radix(&hash[i * 2..i * 2 + 2], 16).unwrap_or(0);
            xored.push(k ^ byte);
        }
        // URL-safe-ish：去掉 / + =，与参考实现一致（不补 -_）。
        let middle = BASE64_STD
            .encode(&xored)
            .chars()
            .filter(|c| !matches!(c, '/' | '+' | '='))
            .collect::<String>();

        format!("zzc{part1}{middle}{part2}").to_lowercase()
    }

    /// 标准 base64（含填充）：扫码登录把二维码 PNG 编成 data URL 复用，
    /// 避免在平台模块再抄一份编码表。
    pub(crate) fn b64_encode_std(data: &[u8]) -> String {
        BASE64_STD.encode(data)
    }

    // 20 字节固定输入，手写 base64 比引 crate 更直观（也避免新依赖）。
    const BASE64_STD: Base64 = Base64;
    struct Base64;
    impl Base64 {
        const TBL: &'static [u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        fn encode(&self, data: &[u8]) -> String {
            let mut out = String::new();
            for chunk in data.chunks(3) {
                let b0 = chunk[0] as u32;
                let b1 = *chunk.get(1).unwrap_or(&0) as u32;
                let b2 = *chunk.get(2).unwrap_or(&0) as u32;
                let triple = (b0 << 16) | (b1 << 8) | b2;
                out.push(Self::TBL[((triple >> 18) & 63) as usize] as char);
                out.push(Self::TBL[((triple >> 12) & 63) as usize] as char);
                if chunk.len() > 1 {
                    out.push(Self::TBL[((triple >> 6) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
                if chunk.len() > 2 {
                    out.push(Self::TBL[(triple & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn md5_known_vectors() {
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
    }

    #[test]
    fn kugou_mobile_key_is_md5_hash_plus_kgcloud() {
        assert_eq!(kugou::mobile_key("abc"), md5_hex(b"abckgcloud"));
    }

    #[test]
    fn kugou_h5_sign_wraps_with_salt_and_sorts_keys() {
        let mut p = BTreeMap::new();
        p.insert("b".to_string(), "2".to_string());
        p.insert("a".to_string(), "1".to_string());
        let want = md5_hex(format!("{}a=1b=2{}", kugou::H5_SALT, kugou::H5_SALT).as_bytes());
        assert_eq!(kugou::h5_sign(&p, None), want);
    }

    #[test]
    fn kugou_android_sign_includes_body_between_salts() {
        let mut p = BTreeMap::new();
        p.insert("a".to_string(), "1".to_string());
        let want = md5_hex(
            format!(
                "{}a=1{}{}",
                kugou::ANDROID_SALT,
                "BODY",
                kugou::ANDROID_SALT
            )
            .as_bytes(),
        );
        assert_eq!(kugou::android_sign(&p, "BODY"), want);
    }

    #[test]
    fn qq_zzc_is_deterministic_and_shaped() {
        let s1 = qq::zzc_sign(r#"{"comm":{"ct":11}}"#);
        let s2 = qq::zzc_sign(r#"{"comm":{"ct":11}}"#);
        assert_eq!(s1, s2);
        assert!(s1.starts_with("zzc"));
        assert!(!s1.contains('/') && !s1.contains('+') && !s1.contains('='));
        assert_eq!(s1, s1.to_lowercase());
    }

    #[test]
    fn qq_gtk33_matches_documented_recurrence() {
        assert_eq!(qq::gtk33(""), 0);
        assert_eq!(qq::gtk33("A"), 65);
    }

    /// KAT：期望值按 spec §2.2 文字用独立脚本（SHA1 十六进制 + 手工按
    /// 1 基位置取字 + scramble XOR + 标准 base64）对固定输入
    /// `{"comm":{"ct":"11"}}` 计算，锁死算法不被无意改动。
    /// （sha1 = 757415702b3995a91a67bc32967de71f8138584d）
    #[test]
    fn qq_zzc_known_answer_vector() {
        assert_eq!(
            qq::zzc_sign(r#"{"comm":{"ct":"11"}}"#),
            "zzc35589d76lfom5vfrr1wruwzj7j0vmg6zif497f96701"
        );
    }

    /// KAT：19 字符的类 qrsig 输入，覆盖多轮递推与 31 位掩码。期望值独立
    /// 按 h = (h*33 + c) mod 2^32 逐步计算。
    #[test]
    fn qq_gtk33_known_answer_vector() {
        assert_eq!(qq::gtk33("QRSIG-9f3a7c1e-2026"), 1_487_612_269);
    }

    /// KAT：扫码 PNG data URL 复用的标准 base64 编码器（RFC 4648 向量 + 空串
    /// 与 PNG 魔数前 8 字节）。
    #[test]
    fn qq_b64_encode_std_matches_rfc4648() {
        assert_eq!(qq::b64_encode_std(b""), "");
        assert_eq!(qq::b64_encode_std(b"f"), "Zg==");
        assert_eq!(qq::b64_encode_std(b"fo"), "Zm8=");
        assert_eq!(qq::b64_encode_std(b"foo"), "Zm9v");
        assert_eq!(
            qq::b64_encode_std(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
            "iVBORw0KGgo="
        );
    }
}
