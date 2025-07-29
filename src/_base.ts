import { webcrypto } from '@substrate-system/one-webcrypto'
import { fromString, type SupportedEncodings, toString } from 'uint8arrays'
import { get, set, delMany } from 'idb-keyval'
import {
    RSA_ALGORITHM,
    DEFAULT_RSA_SIZE,
    DEFAULT_HASH_ALGORITHM,
    RSA_SIGN_ALGORITHM,
    DEFAULT_CHAR_SIZE,
    DEFAULT_SYMM_ALGORITHM,
    DEFAULT_SYMM_LENGTH,
    AES_GCM,
    DEFAULT_ENC_NAME,
    DEFAULT_SIG_NAME,
    IV_LENGTH,
} from './constants.js'
import {
    SymmKeyLength,
    type SymmAlgorithm,
    KeyUse,
    type RsaSize,
    HashAlg,
    type DID,
    type Msg,
    type CharSize,
    type SymmKey,
} from './types.js'
import {
    publicKeyToDid,
    getPublicKeyAsArrayBuffer,
    rsaOperations,
    didToPublicKey,
    importPublicKey,
    toBase64,
    isCryptoKey,
    normalizeUnicodeToBuf,
    importKey,
    randomBuf,
    joinBufs,
    normalizeBase64ToBuf,
    base64ToArrBuf,
    sha256,
    getPublicKeyAsUint8Array,
    normalizeToBuf
} from './util.js'

export { publicKeyToDid, getPublicKeyAsArrayBuffer }
export * from './constants.js'

export type { DID }

export { getPublicKeyAsUint8Array } from './util.js'

export type SerializedKeys = {
    DID:DID;
    publicEncryptKey:string;
}

/**
 * Expose RSA keys only for now, because we are
 * waiting for more browsers to support ECC.
 *
 * Create an instance with `Keys.create` b/c async.
 */
export class Keys {

}

async function makeRSAKeypair (
    size:RsaSize,
    hashAlg:HashAlg,
    use:KeyUse
):Promise<CryptoKeyPair> {
    if (!(Object.values(KeyUse).includes(use))) {
        throw new Error('invalid key use')
    }
    const alg = use === KeyUse.Exchange ? RSA_ALGORITHM : RSA_SIGN_ALGORITHM
    const uses:KeyUsage[] = (use === KeyUse.Exchange ?
        ['encrypt', 'decrypt'] :
        ['sign', 'verify'])

    return webcrypto.subtle.generateKey({
        name: alg,
        modulusLength: size,
        publicExponent: publicExponent(),
        hash: { name: hashAlg }
    }, false, uses)
}

function publicExponent ():Uint8Array {
    return new Uint8Array([0x01, 0x00, 0x01])
}

/**
 * Check that the given signature is valid with the given message.
 */
export async function verify (
    msg:string|Uint8Array,
    sig:string|Uint8Array,
    signingDid:DID
):Promise<boolean> {
    const _key = didToPublicKey(signingDid)
    const key = await importPublicKey(
        _key.publicKey.buffer,
        HashAlg.SHA_256,
        KeyUse.Sign
    )

    try {
        const isOk = rsaOperations.verify(msg, sig, key)
        return isOk
    } catch (_err) {
        return false
    }
}

/**
 * Encrypt the given message to the given public key. If an AES key is not
 * provided, one will be created. Use an AES key to encrypt the given
 * content, then we encrypt the AES key to the given public key.
 *
 * @param {{ content, publicKey }} opts The content to encrypt and
 * public key to encrypt to
 * @param {SymmKey|Uint8Array|string} [aesKey] An optional AES key to encrypt
 * to the given public key
 * @returns {Promise<ArrayBuffer>} The encrypted AES key, concattenated with
 *   the encrypted content.
 */
export async function encryptTo (
    opts:{
        content:string|Uint8Array;
        publicKey:CryptoKey|string;
    },
    aesKey?:SymmKey|Uint8Array|string,
):Promise<ArrayBuffer> {
    const { content, publicKey } = opts
    const key = aesKey || await AES.create()
    const encryptedContent = await AES.encrypt(
        typeof content === 'string' ? fromString(content) : content,
        typeof key === 'string' ? await AES.import(key) : key,
    )
    const encryptedKey = await encryptKeyTo({ key, publicKey })

    return joinBufs(encryptedKey, encryptedContent)
}

/**
 * Encrypt the given AES key to the given public key. Return the encrypted AES
 * key concattenated with the cipher text.
 *
 * @param { content, publicKey } opts The content to encrypt and key to
 *   encrypt to.
 * @param {SymmKey|Uint8Array|string} [aesKey] Optional -- the AES key. One will
 *   be created if not passed in.
 * @returns {Promise<string>} The encrypted AES key concattenated with the
 *   cipher text.
 */
encryptTo.asString = async function (
    opts:{ content:string|Uint8Array; publicKey:CryptoKey|string },
    aesKey?:SymmKey|Uint8Array|string
):Promise<string> {
    const { content, publicKey } = opts
    const key = aesKey || await AES.create()
    const encryptedContent = await AES.encrypt(
        typeof content === 'string' ? fromString(content) : content,
        typeof key === 'string' ? await AES.import(key) : key,
        'arraybuffer'
    )

    const encryptedKey = await encryptKeyTo({ key, publicKey })
    const joined = joinBufs(encryptedKey, encryptedContent)

    return toString(new Uint8Array(joined), 'base64pad')
}

export const AES = {
    create (opts:{ alg:string, length:number } = {
        alg: DEFAULT_SYMM_ALGORITHM,
        length: DEFAULT_SYMM_LENGTH
    }):Promise<CryptoKey> {
        return webcrypto.subtle.generateKey({
            name: opts.alg,
            length: opts.length
        }, true, ['encrypt', 'decrypt'])
    },

    export: Object.assign(
        async (key:CryptoKey):Promise<Uint8Array> => {
            const raw = await webcrypto.subtle.exportKey('raw', key)
            return new Uint8Array(raw)
        },

        {
            asString: async (key:CryptoKey, format?:SupportedEncodings) => {
                const raw = await AES.export(key)
                return format ? toString(raw, format) : toBase64(raw)
            }
        }
    ),

    import (key:Uint8Array|string):Promise<CryptoKey> {
        return importAesKey(typeof key === 'string' ? base64ToArrBuf(key) : key)
    },

    async exportAsString (key:CryptoKey):Promise<string> {
        const raw = await AES.export(key)
        return toBase64(raw)
    },

    encrypt,

    async decrypt (
        encryptedData:Uint8Array|string|ArrayBuffer,
        cryptoKey:CryptoKey|Uint8Array|ArrayBuffer,
        iv?:Uint8Array
    ):Promise<Uint8Array> {
        const key = (isCryptoKey(cryptoKey) ?
            cryptoKey :
            await importAesKey(cryptoKey))

        // the `iv` is prefixed to the cipher text
        const decrypted = (iv ?
            await webcrypto.subtle.decrypt(
                {
                    name: AES_GCM,
                    iv
                },
                key,
                (typeof encryptedData === 'string' ?
                    fromString(encryptedData) :
                    encryptedData)
            ) :

            await decryptBytes(encryptedData, key))

        return new Uint8Array(decrypted)
    },
}

export async function encryptKeyTo ({ key, publicKey }:{
    key:string|Uint8Array|CryptoKey;
    publicKey:CryptoKey|Uint8Array|string;
}, format:'arraybuffer'):Promise<ArrayBuffer>

export async function encryptKeyTo ({ key, publicKey }:{
    key:string|Uint8Array|CryptoKey;
    publicKey:CryptoKey|Uint8Array|string;
}, format:'uint8array'):Promise<Uint8Array>

export async function encryptKeyTo ({ key, publicKey }:{
    key:string|Uint8Array|CryptoKey;
    publicKey:CryptoKey|Uint8Array|string;
}, format?:undefined):Promise<Uint8Array>

/**
 * Encrypt the given content to the given public key. This is RSA encryption,
 * and should be used only to encrypt AES keys.
 *
 * @param {{ content, publicKey }} params The content to encrypt, and public key
 * to encrypt it to.
 * @returns {Promise<Uint8Array>}
 */
export async function encryptKeyTo ({ key, publicKey }:{
    key:string|Uint8Array|CryptoKey;
    publicKey:CryptoKey|Uint8Array|string;
}, format?:'uint8array'|'arraybuffer'):Promise<Uint8Array|ArrayBuffer> {
    let _key:Uint8Array|string
    if (key instanceof CryptoKey) {
        _key = await AES.export(key)
    } else {
        _key = key
    }

    const buf = await rsaOperations.encrypt(_key, publicKey)
    if (format && format === 'arraybuffer') return buf
    return new Uint8Array(buf)
}

encryptKeyTo.asString = async function ({ key, publicKey }:{
    key:string|Uint8Array|CryptoKey;
    publicKey:CryptoKey|string|Uint8Array;
}, format?:SupportedEncodings):Promise<string> {
    const asArr = await encryptKeyTo({ key, publicKey })
    return format ? toString(asArr, format) : toBase64(asArr)
}

function importAesKey (
    key:Uint8Array|ArrayBuffer,
    length?:number
):Promise<CryptoKey> {
    return webcrypto.subtle.importKey(
        'raw',
        key,
        {
            name: AES_GCM,
            length: length || SymmKeyLength.B256,
        },
        true,
        ['encrypt', 'decrypt']
    )
}

async function encryptBytes (
    msg:Msg,
    key:CryptoKey|string,
    opts?:Partial<{ iv:ArrayBuffer, charsize:number }>
):Promise<ArrayBuffer> {
    const data = normalizeUnicodeToBuf(msg, opts?.charsize ?? DEFAULT_CHAR_SIZE)
    const importedKey = typeof key === 'string' ?
        await importKey(key, opts) :
        key
    const iv:ArrayBuffer = opts?.iv || randomBuf(IV_LENGTH)
    const cipherBuf = await webcrypto.subtle.encrypt({
        name: AES_GCM,
        iv
    }, importedKey, data)

    return joinBufs(iv, cipherBuf)
}

/**
 * Decrypt the given message with the given key. We expect the `iv` to be
 * prefixed to the encrypted message.
 * @param msg The message to decrypt
 * @param key The key to decrypt with
 * @param opts Optional args for algorithm and stuff
 * @returns {Promise<ArrayBuffer>}
 */
async function decryptBytes (
    msg:Msg,
    key:CryptoKey|string,
    opts?:Partial<{
        alg:SymmAlgorithm;
        length: SymmKeyLength;
        iv: ArrayBuffer;
    }>
):Promise<ArrayBuffer> {
    const cipherText = normalizeBase64ToBuf(msg)
    const importedKey = typeof key === 'string' ?
        await importKey(key, opts) :
        key
    // `iv` is prefixed to the cypher text
    const iv = cipherText.slice(0, IV_LENGTH)
    const cipherBytes = cipherText.slice(IV_LENGTH)
    const msgBuff = await webcrypto.subtle.decrypt({
        name: DEFAULT_SYMM_ALGORITHM,
        iv
    }, importedKey, cipherBytes)

    return msgBuff
}

async function encrypt (
    data:Uint8Array,
    cryptoKey:CryptoKey|Uint8Array,
    format?:undefined,
    iv?:Uint8Array
):Promise<Uint8Array>

async function encrypt (
    data:Uint8Array,
    cryptoKey:CryptoKey|Uint8Array,
    format:'uint8array',
    iv?:Uint8Array
):Promise<Uint8Array>

async function encrypt (
    data:Uint8Array,
    cryptoKey:CryptoKey|Uint8Array,
    format:'arraybuffer',
    iv?:Uint8Array
):Promise<ArrayBuffer>

async function encrypt (
    data:Uint8Array,
    cryptoKey:CryptoKey|Uint8Array,
    format?:'uint8array'|'arraybuffer',
    iv?:Uint8Array
):Promise<Uint8Array|ArrayBuffer> {
    const key = (isCryptoKey(cryptoKey) ?
        cryptoKey :
        await importAesKey(cryptoKey)
    )

    // prefix the `iv` into the cipher text
    const encrypted = (iv ?
        await webcrypto.subtle.encrypt({ name: AES_GCM, iv }, key, data) :
        await encryptBytes(data, key)
    )

    if (format && format === 'arraybuffer') return encrypted

    return new Uint8Array(encrypted)
}

export async function getDeviceName (did:DID|string) {
    const hashedUsername = await sha256(
        new TextEncoder().encode(did.normalize('NFD'))
    )

    return toString(hashedUsername, 'base32').slice(0, 32)
}

