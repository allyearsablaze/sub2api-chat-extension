import CryptoJS from 'crypto-js'
import { toolRegistry, jsonSchema, schemaTypes as t } from './registry.js'
import { AppError } from '../../common/errors.js'

/* ------------------------------- 编解码工具 ------------------------------- */

function bytesToWordArray(bytes) {
  const words = []
  for (let i = 0; i < bytes.length; i += 1) {
    words[i >>> 2] |= bytes[i] << (24 - (i % 4) * 8)
  }
  return CryptoJS.lib.WordArray.create(words, bytes.length)
}

function wordArrayToBytes(wordArray) {
  const { words, sigBytes } = wordArray
  const bytes = new Uint8Array(sigBytes)
  for (let i = 0; i < sigBytes; i += 1) {
    bytes[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff
  }
  return bytes
}

function bytesToBase64(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(text) {
  const binary = atob(String(text).replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function hexToBytes(text) {
  const clean = String(text).replace(/[^0-9a-fA-F]/g, '')
  const bytes = new Uint8Array(Math.floor(clean.length / 2))
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

function unicodeEncode(text) {
  return Array.from(String(text))
    .map((char) => {
      const code = char.codePointAt(0)
      if (code <= 0x7f) return char
      if (code <= 0xffff) return `\\u${code.toString(16).padStart(4, '0')}`
      return Array.from(char)
        .map((part) => `\\u${part.charCodeAt(0).toString(16).padStart(4, '0')}`)
        .join('')
    })
    .join('')
}

function parseBytes(value, encoding = 'utf8') {
  const text = String(value ?? '')
  switch (String(encoding).toLowerCase()) {
    case 'base64':
      return base64ToBytes(text)
    case 'hex':
      return hexToBytes(text)
    case 'utf8':
    case 'utf-8':
      return new TextEncoder().encode(text)
    default:
      throw new AppError(`不支持的编码：${encoding}`, 'ENCODING_UNSUPPORTED')
  }
}

function formatBytes(bytes, encoding = 'base64') {
  switch (String(encoding).toLowerCase()) {
    case 'base64':
      return bytesToBase64(bytes)
    case 'hex':
      return bytesToHex(bytes)
    case 'utf8':
    case 'utf-8':
      return new TextDecoder().decode(bytes)
    default:
      throw new AppError(`不支持的编码：${encoding}`, 'ENCODING_UNSUPPORTED')
  }
}

const CIPHERS = {
  AES: CryptoJS.AES,
  DES: CryptoJS.DES,
  '3DES': CryptoJS.TripleDES,
  TripleDES: CryptoJS.TripleDES
}

const MODES = {
  CBC: CryptoJS.mode.CBC,
  ECB: CryptoJS.mode.ECB,
  CFB: CryptoJS.mode.CFB,
  OFB: CryptoJS.mode.OFB,
  CTR: CryptoJS.mode.CTR
}

function symmetricKey(args) {
  const bytes = parseBytes(args.key, args.keyEncoding || 'utf8')
  return bytesToWordArray(bytes)
}

function runSymmetric(args, decrypt) {
  const algorithm = String(args.algorithm || 'AES').toUpperCase()
  const cipher = CIPHERS[algorithm]
  if (!cipher) throw new AppError(`不支持的算法：${algorithm}`, 'CIPHER_UNSUPPORTED')
  const mode = MODES[String(args.mode || 'CBC').toUpperCase()] || MODES.CBC
  const key = symmetricKey(args)
  const options = { mode, padding: CryptoJS.pad.Pkcs7 }
  if (String(args.mode || 'CBC').toUpperCase() !== 'ECB' && args.iv) {
    options.iv = bytesToWordArray(parseBytes(args.iv, args.ivEncoding || 'utf8'))
  }
  if (decrypt) {
    const cipherBytes = parseBytes(args.ciphertext, args.cipherEncoding || 'base64')
    const decrypted = cipher.decrypt({ ciphertext: bytesToWordArray(cipherBytes) }, key, options)
    const bytes = wordArrayToBytes(decrypted)
    return { ok: true, text: formatBytes(bytes, args.outputEncoding || 'utf8') }
  }
  const plainBytes = parseBytes(args.plaintext, args.plainEncoding || 'utf8')
  const encrypted = cipher.encrypt(bytesToWordArray(plainBytes), key, options)
  const bytes = wordArrayToBytes(encrypted.ciphertext)
  return { ok: true, text: formatBytes(bytes, args.outputEncoding || 'base64') }
}

/* --------------------------------- 工具注册 --------------------------------- */

const utilTools = [
        {
    name: 'crypto_encrypt',
    category: 'crypto',
    expose: 'admin',
    description: '对称加密（AES/DES/3DES），支持 CBC/ECB/CFB/OFB/CTR 与 utf8/base64/hex 编解码。',
    parameters: jsonSchema(
      {
        algorithm: t.string('AES | DES | 3DES，默认 AES'),
        mode: t.string('CBC | ECB | CFB | OFB | CTR，默认 CBC'),
        key: t.string('密钥'),
        keyEncoding: t.string('密钥编码，默认 utf8'),
        iv: t.string('初始向量（ECB 不需要）'),
        ivEncoding: t.string('IV 编码，默认 utf8'),
        plaintext: t.string('明文'),
        plainEncoding: t.string('明文编码，默认 utf8'),
        outputEncoding: t.string('输出编码，默认 base64')
      },
      ['key', 'plaintext']
    ),
    handler: async (args) => runSymmetric(args, false)
  },
  {
    name: 'crypto_decrypt',
    category: 'crypto',
    expose: 'admin',
    description: '对称解密（AES/DES/3DES），参数与 crypto_encrypt 对应。',
    parameters: jsonSchema(
      {
        algorithm: t.string('AES | DES | 3DES，默认 AES'),
        mode: t.string('CBC | ECB | CFB | OFB | CTR，默认 CBC'),
        key: t.string('密钥'),
        keyEncoding: t.string('密钥编码，默认 utf8'),
        iv: t.string('初始向量'),
        ivEncoding: t.string('IV 编码，默认 utf8'),
        ciphertext: t.string('密文'),
        cipherEncoding: t.string('密文编码，默认 base64'),
        outputEncoding: t.string('输出编码，默认 utf8')
      },
      ['key', 'ciphertext']
    ),
    handler: async (args) => runSymmetric(args, true)
  },
  {
    name: 'hash_digest',
    category: 'crypto',
    expose: 'admin',
    description: '计算摘要：MD5 / SHA1 / SHA256 / SHA512。',
    parameters: jsonSchema(
      {
        text: t.string('原文'),
        algorithm: t.string('算法，默认 SHA256'),
        inputEncoding: t.string('输入编码，默认 utf8'),
        outputEncoding: t.string('输出编码，默认 hex')
      },
      ['text']
    ),
    handler: async (args) => {
      const algorithm = String(args.algorithm || 'SHA256').toUpperCase()
      const fn = { MD5: CryptoJS.MD5, SHA1: CryptoJS.SHA1, SHA256: CryptoJS.SHA256, SHA512: CryptoJS.SHA512 }[algorithm]
      if (!fn) throw new AppError(`不支持的摘要算法：${algorithm}`, 'DIGEST_UNSUPPORTED')
      const bytes = parseBytes(args.text, args.inputEncoding || 'utf8')
      const digest = fn(bytesToWordArray(bytes))
      const outBytes = wordArrayToBytes(digest)
      return { ok: true, digest: formatBytes(outBytes, args.outputEncoding || 'hex') }
    }
  },
  {
    name: 'hmac_sign',
    category: 'crypto',
    expose: 'admin',
    description: 'HMAC 签名：MD5 / SHA1 / SHA256 / SHA512。',
    parameters: jsonSchema(
      {
        text: t.string('原文'),
        key: t.string('密钥'),
        algorithm: t.string('算法，默认 SHA256'),
        outputEncoding: t.string('输出编码，默认 base64')
      },
      ['text', 'key']
    ),
    handler: async (args) => {
      const algorithm = String(args.algorithm || 'SHA256').toUpperCase()
      const fn = { MD5: CryptoJS.HmacMD5, SHA1: CryptoJS.HmacSHA1, SHA256: CryptoJS.HmacSHA256, SHA512: CryptoJS.HmacSHA512 }[
        algorithm
      ]
      if (!fn) throw new AppError(`不支持的 HMAC 算法：${algorithm}`, 'HMAC_UNSUPPORTED')
      const signature = fn(String(args.text), String(args.key))
      return { ok: true, signature: formatBytes(wordArrayToBytes(signature), args.outputEncoding || 'base64') }
    }
  },
  {
    name: 'rsa_generate_keypair',
    category: 'crypto',
    expose: 'admin',
    description: '生成 RSA-OAEP(SHA-256) 密钥对，返回 base64 的 SPKI 公钥与 PKCS8 私钥。',
    parameters: jsonSchema({ modulusLength: t.number('密钥长度，默认 2048') }),
    handler: async (args) => {
      const pair = await crypto.subtle.generateKey(
        {
          name: 'RSA-OAEP',
          modulusLength: args.modulusLength || 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256'
        },
        true,
        ['encrypt', 'decrypt']
      )
      const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
      const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
      return { ok: true, publicKey: bytesToBase64(spki), privateKey: bytesToBase64(pkcs8) }
    }
  },
  {
    name: 'rsa_encrypt',
    category: 'crypto',
    expose: 'admin',
    description: 'RSA-OAEP 加密。公钥为 base64 编码的 SPKI。',
    parameters: jsonSchema(
      { publicKey: t.string('base64 SPKI 公钥'), plaintext: t.string('明文'), outputEncoding: t.string('输出编码，默认 base64') },
      ['publicKey', 'plaintext']
    ),
    handler: async (args) => {
      const key = await crypto.subtle.importKey(
        'spki',
        base64ToBytes(args.publicKey),
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        false,
        ['encrypt']
      )
      const cipher = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(args.plaintext))
      return { ok: true, text: formatBytes(new Uint8Array(cipher), args.outputEncoding || 'base64') }
    }
  },
  {
    name: 'rsa_decrypt',
    category: 'crypto',
    expose: 'admin',
    description: 'RSA-OAEP 解密。私钥为 base64 编码的 PKCS8。',
    parameters: jsonSchema(
      {
        privateKey: t.string('base64 PKCS8 私钥'),
        ciphertext: t.string('密文'),
        inputEncoding: t.string('密文编码，默认 base64'),
        outputEncoding: t.string('输出编码，默认 utf8')
      },
      ['privateKey', 'ciphertext']
    ),
    handler: async (args) => {
      const key = await crypto.subtle.importKey(
        'pkcs8',
        base64ToBytes(args.privateKey),
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        false,
        ['decrypt']
      )
      const plain = await crypto.subtle.decrypt(
        { name: 'RSA-OAEP' },
        key,
        parseBytes(args.ciphertext, args.inputEncoding || 'base64')
      )
      return { ok: true, text: formatBytes(new Uint8Array(plain), args.outputEncoding || 'utf8') }
    }
  },
  {
    name: 'encoding_convert',
    category: 'util',
    description: '编码转换：utf8 / base64 / hex / unicode 互转。',
    parameters: jsonSchema(
      { text: t.string('输入文本'), from: t.string('源编码，默认 utf8'), to: t.string('目标编码，默认 base64') },
      ['text']
    ),
    handler: async (args) => {
      const from = String(args.from || 'utf8').toLowerCase()
      const to = String(args.to || 'base64').toLowerCase()
      if (to === 'unicode') return { ok: true, text: unicodeEncode(args.text) }
      if (from === 'unicode') {
        const decoded = String(args.text).replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) =>
          String.fromCharCode(parseInt(hex, 16))
        )
        return { ok: true, text: formatBytes(parseBytes(decoded, 'utf8'), to === 'unicode' ? 'utf8' : to) }
      }
      return { ok: true, text: formatBytes(parseBytes(args.text, from), to) }
    }
  },
  {
    name: 'url_encode',
    category: 'util',
    description: 'URL 编码（component=true 时等价 encodeURIComponent）。',
    parameters: jsonSchema({ text: t.string('文本'), component: t.boolean('是否按组件编码') }, ['text']),
    handler: async (args) => ({
      ok: true,
      text: args.component === false ? encodeURI(String(args.text)) : encodeURIComponent(String(args.text))
    })
  },
  {
    name: 'url_decode',
    category: 'util',
    description: 'URL 解码。',
    parameters: jsonSchema({ text: t.string('文本'), component: t.boolean('是否按组件解码') }, ['text']),
    handler: async (args) => {
      try {
        return { ok: true, text: args.component === false ? decodeURI(String(args.text)) : decodeURIComponent(String(args.text)) }
      } catch (error) {
        return { ok: false, error: `解码失败：${error.message}` }
      }
    }
  },
  {
    name: 'jwt_decode',
    category: 'util',
    description: '解析 JWT 的 header 与 payload（不校验签名）。',
    parameters: jsonSchema({ token: t.string('JWT') }, ['token']),
    handler: async (args) => {
      const parts = String(args.token).split('.')
      if (parts.length < 2) return { ok: false, error: '不是合法的 JWT' }
      const decodePart = (part) => {
        const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')
        return JSON.parse(new TextDecoder().decode(base64ToBytes(padded)))
      }
      try {
        return { ok: true, header: decodePart(parts[0]), payload: decodePart(parts[1]) }
      } catch (error) {
        return { ok: false, error: `解析失败：${error.message}` }
      }
    }
  },
  {
    name: 'jsonpath_query',
    category: 'util',
    description: '简易 JSONPath 查询，支持 $.a.b[0].c 与 $.items[*].id。',
    parameters: jsonSchema({ json: t.object('JSON 对象'), path: t.string('路径表达式') }, ['json', 'path']),
    handler: async (args) => {
      const tokens = String(args.path || '$')
        .replace(/^\$\.?/, '')
        .replace(/\[(\d+)\]/g, '.$1')
        .split('.')
        .filter(Boolean)
      let current = [args.json]
      for (const token of tokens) {
        const next = []
        for (const node of current) {
          if (node === null || node === undefined) continue
          if (token === '*') {
            if (Array.isArray(node)) next.push(...node)
            else if (typeof node === 'object') next.push(...Object.values(node))
            continue
          }
          next.push(node[token])
        }
        current = next
      }
      const result = current.length === 1 ? current[0] : current
      return { ok: true, value: result === undefined ? null : result }
    }
  },
  {
    name: 'regex_extract',
    category: 'util',
    description: '正则提取文本，all=true 时返回全部匹配。',
    parameters: jsonSchema(
      {
        text: t.string('原文'),
        pattern: t.string('正则表达式'),
        flags: t.string('标志，默认 g'),
        all: t.boolean('是否返回全部匹配'),
        group: t.number('取第几个捕获组，默认 0')
      },
      ['text', 'pattern']
    ),
    handler: async (args) => {
      const flags = args.flags === undefined ? 'g' : String(args.flags)
      const regex = new RegExp(String(args.pattern), flags)
      const group = args.group || 0
      if (args.all) {
        const matches = [...String(args.text).matchAll(regex)].map((match) => match[group] ?? match[0])
        return { ok: true, matches, count: matches.length }
      }
      const match = regex.exec(String(args.text))
      return { ok: !!match, match: match ? match[group] ?? match[0] : null }
    }
  },
  {
    name: 'random_uuid',
    category: 'util',
    description: '生成带连字符的 UUID v4。',
    parameters: jsonSchema({}),
    handler: async () => ({ ok: true, value: crypto.randomUUID() })
  },
  {
    name: 'random_uuid32',
    category: 'util',
    description: '生成 32 位无连字符 UUID。',
    parameters: jsonSchema({}),
    handler: async () => ({ ok: true, value: crypto.randomUUID().replace(/-/g, '') })
  },
  {
    name: 'random_string',
    category: 'util',
    description: '生成随机字符串，charset 可选 alnum / alpha / digit / hex / custom。',
    parameters: jsonSchema({ length: t.number('长度，默认 16'), charset: t.string('字符集'), customChars: t.string('自定义字符集') }, ['length']),
    handler: async (args) => {
      const charsets = {
        alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
        alpha: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
        digit: '0123456789',
        hex: '0123456789abcdef'
      }
      const chars = args.charset === 'custom' ? String(args.customChars || '') : charsets[args.charset || 'alnum']
      if (!chars) throw new AppError('字符集为空', 'RANDOM_CHARSET_EMPTY')
      const length = Math.max(1, Math.min(4096, Number(args.length) || 16))
      const bytes = new Uint32Array(length)
      crypto.getRandomValues(bytes)
      let result = ''
      for (const value of bytes) result += chars[value % chars.length]
      return { ok: true, value: result }
    }
  },
  {
    name: 'random_number',
    category: 'util',
    description: '生成指定区间的随机数，integer=true 返回整数。',
    parameters: jsonSchema({
      min: t.number('最小值，默认 0'),
      max: t.number('最大值，默认 100'),
      integer: t.boolean('是否整数，默认 true')
    }),
    handler: async (args) => {
      const min = Number(args.min ?? 0)
      const max = Number(args.max ?? 100)
      if (min > max) throw new AppError('min 不能大于 max', 'RANDOM_RANGE_INVALID')
      const value = min + Math.random() * (max - min)
      return { ok: true, value: args.integer === false ? value : Math.floor(value) }
    }
  }
]

export function registerUtilTools() {
  for (const tool of utilTools) toolRegistry.register(tool)
}

export const utilToolNames = utilTools.map((tool) => tool.name)
