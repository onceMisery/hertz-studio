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

/// 酷我移动端取流接口（mobi.s）的请求载荷加密。
///
/// 酷我客户端自身使用的变形 DES：E 扩展与 PC2 置换表带 -1 空洞（每个字节
/// 只用低 6 位，S 盒因此是 64 项的全字节查表）、S 盒数值非标准。只用于构造
/// 取流请求的 `q` 参数，不涉及任何音频内容解密。算法照 lx-source 的 Go
/// 实现逐位移植；期望值由真机服务器验证——该密文 2026-09-27 实测被
/// mobi.s 接受并返回真实 128k 直链（spike 见 aegis 证据）。
pub mod kuwo {
    use super::qq::b64_encode_std;

    const SECRET_KEY: [u8; 8] = *b"ylzsxkwm";

    const ARRAY_E: [i64; 64] = [
        31, 0, 1, 2, 3, 4, -1, -1, 3, 4, 5, 6, 7, 8, -1, -1, 7, 8, 9, 10, 11, 12, -1, -1, 11, 12,
        13, 14, 15, 16, -1, -1, 15, 16, 17, 18, 19, 20, -1, -1, 19, 20, 21, 22, 23, 24, -1, -1, 23,
        24, 25, 26, 27, 28, -1, -1, 27, 28, 29, 30, 31, 30, -1, -1,
    ];
    const ARRAY_IP: [i64; 64] = [
        57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5,
        63, 55, 47, 39, 31, 23, 15, 7, 56, 48, 40, 32, 24, 16, 8, 0, 58, 50, 42, 34, 26, 18, 10, 2,
        60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6,
    ];
    const ARRAY_IP_1: [i64; 64] = [
        39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61,
        29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18,
        58, 26, 33, 1, 41, 9, 49, 17, 57, 25, 32, 0, 40, 8, 48, 16, 56, 24,
    ];
    const ARRAY_LS: [i64; 16] = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
    const ARRAY_LS_MASK: [i64; 3] = [0, 0x100001, 0x300003];
    const ARRAY_P: [i64; 32] = [
        15, 6, 19, 20, 28, 11, 27, 16, 0, 14, 22, 25, 4, 17, 30, 9, 1, 7, 23, 13, 31, 26, 2, 8, 18,
        12, 29, 5, 21, 10, 3, 24,
    ];
    const ARRAY_PC_1: [i64; 56] = [
        56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2,
        59, 51, 43, 35, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 60, 52, 44,
        36, 28, 20, 12, 4, 27, 19, 11, 3,
    ];
    const ARRAY_PC_2: [i64; 64] = [
        13, 16, 10, 23, 0, 4, -1, -1, 2, 27, 14, 5, 20, 9, -1, -1, 22, 18, 11, 3, 25, 7, -1, -1,
        15, 6, 26, 19, 12, 1, -1, -1, 40, 51, 30, 36, 46, 54, -1, -1, 29, 39, 50, 44, 32, 47, -1,
        -1, 43, 48, 38, 55, 33, 52, -1, -1, 45, 41, 49, 35, 28, 31, -1, -1,
    ];
    #[rustfmt::skip]
    const MATRIX_NS_BOX: [[i64; 64]; 8] = [
        [14, 4, 3, 15, 2, 13, 5, 3, 13, 14, 6, 9, 11, 2, 0, 5, 4, 1, 10, 12, 15, 6, 9, 10, 1, 8, 12, 7, 8, 11, 7, 0, 0, 15, 10, 5, 14, 4, 9, 10, 7, 8, 12, 3, 13, 1, 3, 6, 15, 12, 6, 11, 2, 9, 5, 0, 4, 2, 11, 14, 1, 7, 8, 13],
        [15, 0, 9, 5, 6, 10, 12, 9, 8, 7, 2, 12, 3, 13, 5, 2, 1, 14, 7, 8, 11, 4, 0, 3, 14, 11, 13, 6, 4, 1, 10, 15, 3, 13, 12, 11, 15, 3, 6, 0, 4, 10, 1, 7, 8, 4, 11, 14, 13, 8, 0, 6, 2, 15, 9, 5, 7, 1, 10, 12, 14, 2, 5, 9],
        [10, 13, 1, 11, 6, 8, 11, 5, 9, 4, 12, 2, 15, 3, 2, 14, 0, 6, 13, 1, 3, 15, 4, 10, 14, 9, 7, 12, 5, 0, 8, 7, 13, 1, 2, 4, 3, 6, 12, 11, 0, 13, 5, 14, 6, 8, 15, 2, 7, 10, 8, 15, 4, 9, 11, 5, 9, 0, 14, 3, 10, 7, 1, 12],
        [7, 10, 1, 15, 0, 12, 11, 5, 14, 9, 8, 3, 9, 7, 4, 8, 13, 6, 2, 1, 6, 11, 12, 2, 3, 0, 5, 14, 10, 13, 15, 4, 13, 3, 4, 9, 6, 10, 1, 12, 11, 0, 2, 5, 0, 13, 14, 2, 8, 15, 7, 4, 15, 1, 10, 7, 5, 6, 12, 11, 3, 8, 9, 14],
        [2, 4, 8, 15, 7, 10, 13, 6, 4, 1, 3, 12, 11, 7, 14, 0, 12, 2, 5, 9, 10, 13, 0, 3, 1, 11, 15, 5, 6, 8, 9, 14, 14, 11, 5, 6, 4, 1, 3, 10, 2, 12, 15, 0, 13, 2, 8, 5, 11, 8, 0, 15, 7, 14, 9, 4, 12, 7, 10, 9, 1, 13, 6, 3],
        [12, 9, 0, 7, 9, 2, 14, 1, 10, 15, 3, 4, 6, 12, 5, 11, 1, 14, 13, 0, 2, 8, 7, 13, 15, 5, 4, 10, 8, 3, 11, 6, 10, 4, 6, 11, 7, 9, 0, 6, 4, 2, 13, 1, 9, 15, 3, 8, 15, 3, 1, 14, 12, 5, 11, 0, 2, 12, 14, 7, 5, 10, 8, 13],
        [4, 1, 3, 10, 15, 12, 5, 0, 2, 11, 9, 6, 8, 7, 6, 9, 11, 4, 12, 15, 0, 3, 10, 5, 14, 13, 7, 8, 13, 14, 1, 2, 13, 6, 14, 9, 4, 1, 2, 14, 11, 13, 5, 0, 1, 10, 8, 3, 0, 11, 3, 5, 9, 4, 15, 2, 7, 8, 12, 15, 10, 7, 6, 12],
        [13, 7, 10, 0, 6, 9, 5, 15, 8, 4, 3, 10, 11, 14, 12, 5, 2, 11, 9, 6, 15, 12, 0, 3, 4, 1, 14, 13, 1, 2, 7, 8, 1, 2, 12, 15, 10, 4, 0, 3, 13, 14, 6, 9, 7, 8, 9, 6, 15, 1, 5, 12, 3, 10, 14, 5, 8, 7, 11, 0, 4, 13, 2, 11],
    ];

    /// 位掩码表。Go 侧 `1 << 63` 溢出后 `*= -1` 是恒等运算，这里直接就是
    /// 符号位，语义一致。
    const fn build_mask() -> [i64; 64] {
        let mut m = [0i64; 64];
        let mut i = 0;
        while i < 64 {
            m[i] = 1i64 << i;
            i += 1;
        }
        m
    }
    const ARRAY_MASK: [i64; 64] = build_mask();

    /// 置换查表：输出位 i 取输入位 arr[i]，-1 表示该输出位恒为 0。
    fn bit_transform(arr: &[i64], l: i64) -> i64 {
        let mut out = 0i64;
        for (i, &src) in arr.iter().enumerate() {
            if src < 0 {
                continue;
            }
            if l & ARRAY_MASK[src as usize] != 0 {
                out |= ARRAY_MASK[i];
            }
        }
        out
    }

    /// 单块 16 轮 Feistel。E 扩展与 PC2 的空洞保证中间值每字节 ≤ 0x3F，
    /// 全字节 S 盒查表因此不会越界。
    fn des64(longs: &[i64; 16], l: i64) -> i64 {
        let out = bit_transform(&ARRAY_IP, l);
        let mut src = [out & 0xFFFF_FFFF, (-0x1_0000_0000i64 & out) >> 32];
        for round in longs {
            let mut r = bit_transform(&ARRAY_E, src[1]) ^ *round;
            let mut s_out = 0i64;
            for sbi in (0..8).rev() {
                s_out <<= 4;
                s_out |= MATRIX_NS_BOX[sbi][((r >> (sbi * 8)) & 0xFF) as usize];
            }
            r = bit_transform(&ARRAY_P, s_out);
            let left = src[0];
            src[0] = src[1];
            src[1] = left ^ r;
        }
        src.swap(0, 1);
        let out = (-0x1_0000_0000i64 & (src[1] << 32)) | (0xFFFF_FFFF & src[0]);
        bit_transform(&ARRAY_IP_1, out)
    }

    fn sub_keys(l: i64) -> [i64; 16] {
        let mut longs = [0i64; 16];
        let mut l2 = bit_transform(&ARRAY_PC_1, l);
        for i in 0..16 {
            let mask = ARRAY_LS_MASK[ARRAY_LS[i] as usize];
            let ls = ARRAY_LS[i] as u32;
            l2 = ((l2 & mask) << (28 - ls)) | ((l2 & !mask) >> ls);
            longs[i] = bit_transform(&ARRAY_PC_2, l2);
        }
        longs
    }

    /// 变形 DES 加密。块内小端装载，尾部不足 8 字节零填充（与 Go 参考实现
    /// 一致，输出恒为 8 字节的倍数）。
    pub fn des_encrypt(msg: &[u8]) -> Vec<u8> {
        let mut l = 0i64;
        for (i, &b) in SECRET_KEY.iter().enumerate() {
            l |= (b as i64) << (i * 8);
        }
        let rounds = sub_keys(l);
        let full = msg.len() / 8;
        let mut blocks = Vec::with_capacity(full + 1);
        for m in 0..full {
            let mut blk = 0i64;
            for (n, &b) in msg[m * 8..m * 8 + 8].iter().enumerate() {
                blk |= (b as i64) << (n * 8);
            }
            blocks.push(des64(&rounds, blk));
        }
        let mut tail = 0i64;
        for (i, &b) in msg[full * 8..].iter().enumerate() {
            tail |= (b as i64) << (i * 8);
        }
        blocks.push(des64(&rounds, tail));
        let mut out = Vec::with_capacity(blocks.len() * 8);
        for blk in blocks {
            for i in 0..8 {
                out.push(((blk >> (i * 8)) & 0xFF) as u8);
            }
        }
        out
    }

    /// mobi.s 的 `q` 参数：加密后做标准 base64。
    pub fn mobi_q(plaintext: &str) -> String {
        b64_encode_std(&des_encrypt(plaintext.as_bytes()))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// KAT：期望值取自 spike 的 JS 中间移植版（同一算法被真机 mobi.s
        /// 接受并返回真实 128k 直链，服务器即 oracle；见 aegis 证据 §2）。
        #[test]
        fn des_known_answer_vector_validated_by_live_server() {
            let plain = "corp=kuwo&p2p=1&sig=0&notrace=0&priority=bitrate&network=WIFI&mode=down\
                         &source=kwplayerhd_ar_5.1.0.0_B_jiakong_vh.apk&type=convert_url_with_sign\
                         &br=128kmp3&format=mp3&rid=311875";
            assert_eq!(mobi_q(plain), "NI8S5evAnmGldi4g47EsqrT7al5u+JTiJ+heOUwqOwcqvgwFyTLvnshjX+I4drxiGXu1L30BOmfLz/L75rBYbwWyAlB/g5IpFLKP5pzBz7HwnFbScG9nzFH952pO6cIz1L6UJVp37dxHHHfzQvSXS7yoB84sKV/ka1id0JcxSGP/4zX/nWSPf7Y7KQRWCXwNvpWJklhTVX1gFtPEklRJ/6WNmoyxI7Y+MVFg5NTDzq7NO9EASknnzw==");
        }

        #[test]
        fn output_is_padded_to_eight_byte_blocks() {
            // 3 字节明文 → 1 个块；177 字节（KAT 明文长度）→ 23 个块。
            assert_eq!(des_encrypt(b"abc").len(), 8);
            assert_eq!(des_encrypt(b"corp=kuwo&rid=311875").len() % 8, 0);
            assert_ne!(des_encrypt(b"abc"), des_encrypt(b"abd"));
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
