import crypto from 'crypto';
import fs from 'fs';
import { JSONStringifyDeterministic } from '../../../common/crypto_util';
import DataStreamy from '../../../common/DataStreamy';
import { randomAlphaString } from '../../../common/util';
import { byteCount, ByteCount, byteCountToNumber, FileKey, FileManifest, FileManifestChunk, isBuffer, localFilePath, LocalFilePath, Sha1Hash } from '../../../interfaces/core';

export class KacheryStorageManager {
    #storageDir: LocalFilePath
    constructor(storageDir: LocalFilePath) {
        if (!fs.existsSync(storageDir.toString())) {
            throw Error(`Kachery storage directory does not exist: ${storageDir}`)
        }
        this.#storageDir = storageDir
    }
    async findFile(fileKey: FileKey): Promise<{ found: boolean, size: ByteCount, localFilePath: LocalFilePath | null }> {
        if (fileKey.sha1) {
            const { path: filePath, size: fileSize } = await this._getLocalFileInfo(fileKey.sha1);
            if ((filePath) && (fileSize !== null)) {
                return { found: true, size: fileSize, localFilePath: filePath }
            }
        }
        if (fileKey.chunkOf) {
            const { path: filePath, size: fileSize } = await this._getLocalFileInfo(fileKey.chunkOf.fileKey.sha1)
            if (filePath) {
                const offset = fileKey.chunkOf.startByte
                const size = byteCount(byteCountToNumber(fileKey.chunkOf.endByte) - byteCountToNumber(fileKey.chunkOf.startByte))
                return { found: true, size, localFilePath: null } // in this case it's not the entire file, so we are not going to return the local file path
            }
        }
        return { found: false, size: byteCount(0), localFilePath: null }
    }
    async storeFile(sha1: Sha1Hash, data: Buffer) {
        const s = sha1;
        const destParentPath = `${this.#storageDir}/sha1/${s[0]}${s[1]}/${s[2]}${s[3]}/${s[4]}${s[5]}`
        const destPath = `${destParentPath}/${s}`
        if (fs.existsSync(destPath)) {
            return
        }
        fs.mkdirSync(destParentPath, {recursive: true});
        const destPathTmp = `${destPath}.${randomAlphaString(5)}.tmp`
        await fs.promises.writeFile(destPathTmp, data)
        if (fs.existsSync(destPath)) {
            /* istanbul ignore next */
            {
                fs.unlinkSync(destPathTmp)
                return
            }
        }
        fs.renameSync(destPathTmp, destPath)
    }
    async storeLocalFile(localFilePath: LocalFilePath): Promise<{sha1: Sha1Hash, manifestSha1: Sha1Hash | null}> {
        let stat0: fs.Stats
        try {
            stat0 = await fs.promises.stat(localFilePath.toString())
        }
        catch (err) {
            throw Error(`Unable to stat file. Perhaps the kachery-p2p daemon does not have permission to read this file: ${localFilePath}`)
        }
        const fileSize = byteCount(stat0.size)
        const ds = createDataStreamForFile(localFilePath, byteCount(0), fileSize)
        const tmpDestPath = `${this.#storageDir}/store.file.${randomAlphaString(10)}.tmp`
        const writeStream = fs.createWriteStream(tmpDestPath)
        const shasum = crypto.createHash('sha1')
        const manifestChunks: FileManifestChunk[] = []
        const manifestData: {
            buffers: Buffer[],
            byte1: number,
            byte2: number
        } = {buffers: [], byte1: 0, byte2: 0}
        let complete = false
        const chunkSize = 20 * 1000 * 1000
        const _updateManifestChunks = ({final}: {final: boolean}) => {
            if ((manifestData.byte2 - manifestData.byte1 >= chunkSize) || ((final) && (manifestData.byte2 > manifestData.byte1))) {
                const d = Buffer.concat(manifestData.buffers)
                manifestData.buffers = []
                for (let i = 0; i < d.length; i+=chunkSize) {
                    const x = d.slice(i, i + Math.min(chunkSize, d.length - i))
                    if ((x.length === chunkSize) || (final)) {
                        manifestChunks.push({
                            start: byteCount(manifestData.byte1),
                            end: byteCount(manifestData.byte1 + x.length),
                            sha1: computeSha1OfBufferSync(x) // note that this is synchronous (not ideal)
                        })
                        manifestData.byte1 += x.length
                    }
                    else {
                        manifestData.buffers.push(x)
                    }
                }
            }
        }
        return new Promise((resolve, reject) => {
            const _cleanup = () => {
                try {
                    fs.unlinkSync(tmpDestPath)
                }
                catch(e) {
                }
            }
            ds.onData(buf => {
                if (complete) return
                shasum.update(buf)
                writeStream.write(buf)
                manifestData.buffers.push(buf)
                manifestData.byte2 += buf.length
                _updateManifestChunks({final: false})
            })
            ds.onError(err => {
                if (complete) return
                complete = true
                _cleanup()
                reject(err)
            })
            ds.onFinished(() => {
                if (complete) return
                complete = true
                try {
                    const sha1Computed = shasum.digest('hex') as any as Sha1Hash
                    const s = sha1Computed
                    const destParentPath = `${this.#storageDir}/sha1/${s[0]}${s[1]}/${s[2]}${s[3]}/${s[4]}${s[5]}`
                    const destPath = `${destParentPath}/${s}`
                    if (fs.existsSync(destPath)) {
                        // if the dest path already exists, we already have the file and we are good
                    }
                    else {
                        // dest path does not already exist
                        fs.mkdirSync(destParentPath, {recursive: true});
                        try {
                            // this line occassionaly fails on our ceph system and it is unclear the reason. So I am catching the error to troubleshoot
                            fs.renameSync(tmpDestPath, destPath)
                        }
                        catch(err) {
                            if (!fs.existsSync(tmpDestPath)) {
                                throw Error(`Unexpected problem renaming file. File does not exist: ${tmpDestPath}: ${err.message}`)
                            }
                            if (!fs.existsSync(destParentPath)) {
                                throw Error(`Unexpected problem renaming file. Destination parent path does not exist: ${destParentPath}: ${err.message}`)
                            }
                            throw Error(`Unexpected problem renaming file. Even though file exists and dest parent directory exists: ${tmpDestPath} ${destParentPath}: ${err.message}`)
                        }
                    }
                    _updateManifestChunks({final: true})
                    const manifest: FileManifest = {
                        size: byteCount(manifestData.byte2),
                        sha1: sha1Computed,
                        chunks: manifestChunks
                    }
                    let manifestSha1: Sha1Hash | null = null
                    if (manifestChunks.length > 1) {
                        const manifestJson = Buffer.from(JSON.stringify(manifest), 'utf-8')
                        manifestSha1 = computeSha1OfBufferSync(manifestJson)
                        this.storeFile(manifestSha1, manifestJson)
                    }
                    resolve({sha1: sha1Computed, manifestSha1})
                }
                catch(err2) {
                    _cleanup()
                    reject(err2)
                }
            })
        })
    }
    async concatenateChunksAndStoreResult(sha1: Sha1Hash, chunkSha1s: Sha1Hash[]): Promise<void> {
        const s = sha1
        const destParentPath = `${this.#storageDir}/sha1/${s[0]}${s[1]}/${s[2]}${s[3]}/${s[4]}${s[5]}`
        const destPath = `${destParentPath}/${s}`
        if (fs.existsSync(destPath)) {
            // already exists
            /* istanbul ignore next */
            return
        }

        // verify we have all the files
        for (let chunkSha1 of chunkSha1s) {
            const f = await this.findFile({sha1: chunkSha1})
            if (!f.found) {
                /* istanbul ignore next */
                throw Error(`Cannot concatenate chunk. Missing chunk: ${chunkSha1}`)
            }
        }

        const tmpPath = createTemporaryFilePath({storageDir: this.#storageDir, prefix: 'kachery-p2p-concat-'})
        const writeStream = fs.createWriteStream(tmpPath)
        const shasum = crypto.createHash('sha1')
        for (let chunkSha1 of chunkSha1s) {
            const readStream = await this.getFileReadStream({sha1: chunkSha1})
            await new Promise<void>((resolve, reject) => {
                readStream.onData(buf => {
                    shasum.update(buf)
                    writeStream.write(buf)
                })
                readStream.onError(err => {
                    reject(err)
                })
                readStream.onFinished(() => {
                    resolve()
                })
            })
        }
        await new Promise<void>((resolve, reject) => {
            writeStream.end(() => {
                const sha1Computed = shasum.digest('hex') as any as Sha1Hash
                if (sha1Computed !== sha1) {
                    /* istanbul ignore next */
                    {
                        /* istanbul ignore next */
                        {
                            reject(Error('Did not get the expected SHA-1 sum for concatenated file'))
                            return
                        }
                    }
                }
                resolve()
            })
        })
        if (fs.existsSync(destPath)) {
            // already exists
            /* istanbul ignore next */
            {
                fs.unlinkSync(tmpPath)
                return
            }
        }
        fs.mkdirSync(destParentPath, {recursive: true});
        fs.renameSync(tmpPath, destPath)
    }
    async hasLocalFile(fileKey: FileKey): Promise<boolean> {
        if (fileKey.sha1) {
            const { path: filePath, size: fileSize } = await this._getLocalFileInfo(fileKey.sha1)
            if ((filePath) && (fileSize !== null)) {
                return true
            }
        }
        if (fileKey.chunkOf) {
            const { path: filePath, size: fileSize } = await this._getLocalFileInfo(fileKey.chunkOf.fileKey.sha1)
            if (filePath) {
                return true
            }
        }
        return false
    }
    async getFileReadStream(fileKey: FileKey): Promise<DataStreamy> {
        if (fileKey.sha1) {
            const { path: filePath, size: fileSize } = await this._getLocalFileInfo(fileKey.sha1)
            if ((filePath) && (fileSize !== null)) {
                return createDataStreamForFile(filePath, byteCount(0), fileSize)
            }
        }
        if (fileKey.chunkOf) {
            const { path: filePath, size: fileSize } = await this._getLocalFileInfo(fileKey.chunkOf.fileKey.sha1)
            if (filePath) {
                const offset = fileKey.chunkOf.startByte
                const size = byteCount(byteCountToNumber(fileKey.chunkOf.endByte) - byteCountToNumber(fileKey.chunkOf.startByte))
                return createDataStreamForFile(filePath, offset, size)
            }
        }
        throw Error('Unable get data read stream for local file.')
    }
    async _getLocalFileInfo(fileSha1: Sha1Hash): Promise<{ path: LocalFilePath | null, size: ByteCount | null }> {
        const s = fileSha1;
        const path = localFilePath(`${this.#storageDir}/sha1/${s[0]}${s[1]}/${s[2]}${s[3]}/${s[4]}${s[5]}/${s}`)
        let stat0: fs.Stats
        try {
            stat0 = await fs.promises.stat(path.toString())
        }
        catch (err) {
            return { path: null, size: null }
        }
        return {
            path,
            size: byteCount(stat0.size)
        }
    }
    storageDir() {
        return this.#storageDir
    }
}

const computeSha1OfBufferSync = (buf: Buffer) => {
    const shasum = crypto.createHash('sha1')
    shasum.update(buf)
    return shasum.digest('hex') as any as Sha1Hash
}

const createDataStreamForFile = (path: LocalFilePath, offset: ByteCount, size: ByteCount) => {
    // note.. for some reason if we put {encoding: 'binary'} we get text data chunks
    const readStream = fs.createReadStream(path.toString(), { start: byteCountToNumber(offset), end: byteCountToNumber(offset) + byteCountToNumber(size) - 1 })
    const ret = new DataStreamy()
    ret.producer().start(size)
    readStream.on('data', (chunk: any) => {
        if (!isBuffer(chunk)) {
            throw Error('Unexpected type of data chunk')
        }
        ret.producer().data(chunk)
    })
    readStream.on('end', () => {
        ret.producer().end()
    })
    readStream.on('error', (err: Error) => {
        ret.producer().error(err)
    })
    ret.producer().onCancelled(() => {
        readStream.close()
    })
    return ret
}

export const createTemporaryFilePath = (args: {storageDir: LocalFilePath, prefix: string}) => {
    const dirPath = args.storageDir + '/tmp'
    fs.mkdirSync(dirPath, {recursive: true})
    return `${dirPath}/${args.prefix}-${randomAlphaString(10)}`
}