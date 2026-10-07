const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

/*
 * ============================================================
 * WINDOWS FILE SYSTEM DATA CONNECTOR
 * ============================================================
 *
 * Scan strategy:
 *
 *   readdir({ withFileTypes: true })
 *          ↓
 *        Dirent
 *          ↓
 *   Directory discovery
 *          ↓
 *   Bounded directory workers
 *          ↓
 *   Bounded file metadata workers
 *          ↓
 *        JSON
 *
 * Optimized for:
 *
 *   1. Local Windows filesystem
 *   2. UNC / SMB network shares
 *   3. Large directory trees
 *
 * Important:
 *
 * We do NOT read file contents during collection.
 * Only filesystem metadata is collected.
 */

/*
 * ============================================================
 * CONFIGURATION
 * ============================================================
 *
 * Local:
 *   default = 32
 *
 * Network:
 *   default = 16
 *
 * Why different?
 *
 * Local SSD/HDD and remote SMB behave differently.
 * Increasing network concurrency blindly can make SMB slower.
 *
 * You can override them from .env.
 */

const DEFAULT_LOCAL_CONCURRENCY = 32;
const DEFAULT_NETWORK_CONCURRENCY = 16;

const MAX_LOCAL_CONCURRENCY = 64;
const MAX_NETWORK_CONCURRENCY = 32;

/*
 * Number of files processed together inside each directory.
 */

const FILE_BATCH_SIZE = 64;

/*
 * ============================================================
 * MIME TYPES
 * ============================================================
 */

const MIME_TYPES = {
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.xml': 'application/xml',

    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',

    '.zip': 'application/zip',
    '.rar': 'application/x-rar-compressed',
    '.7z': 'application/x-7z-compressed',

    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',

    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',

    '.mp4': 'video/mp4',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',

    '.exe': 'application/x-msdownload',
    '.dll': 'application/x-msdownload',

    '.bat': 'text/plain',
    '.cmd': 'text/plain',
    '.ps1': 'text/plain',

    '.py': 'text/plain',
    '.c': 'text/plain',
    '.cpp': 'text/plain',
    '.h': 'text/plain',
    '.cs': 'text/plain',
    '.go': 'text/plain',
    '.rs': 'text/plain',
    '.php': 'text/plain',
    '.sql': 'text/plain',
    '.csv': 'text/csv',
    '.log': 'text/plain',
    '.md': 'text/markdown'
};

/*
 * ============================================================
 * MIME TYPE
 * ============================================================
 */

function getMimeType(extension) {
    if (!extension) {
        return 'application/octet-stream';
    }

    return (
        MIME_TYPES[extension.toLowerCase()] ||
        'application/octet-stream'
    );
}

/*
 * ============================================================
 * FILE TYPE
 * ============================================================
 */

function getFileType(extension) {
    const ext = (extension || '').toLowerCase();

    const imageExtensions = [
        '.jpg',
        '.jpeg',
        '.png',
        '.gif',
        '.bmp',
        '.svg',
        '.ico',
        '.webp'
    ];

    const videoExtensions = [
        '.mp4',
        '.avi',
        '.mkv',
        '.mov'
    ];

    const audioExtensions = [
        '.mp3',
        '.wav',
        '.ogg'
    ];

    const documentExtensions = [
        '.pdf',
        '.doc',
        '.docx',
        '.txt',
        '.rtf',
        '.xls',
        '.xlsx',
        '.csv'
    ];

    const codeExtensions = [
        '.js',
        '.json',
        '.html',
        '.css',
        '.py',
        '.c',
        '.cpp',
        '.h',
        '.cs',
        '.go',
        '.rs',
        '.php',
        '.sql',
        '.sh',
        '.bat',
        '.cmd',
        '.ps1'
    ];

    const archiveExtensions = [
        '.zip',
        '.rar',
        '.7z'
    ];

    if (imageExtensions.includes(ext)) return 'Image';
    if (videoExtensions.includes(ext)) return 'Video';
    if (audioExtensions.includes(ext)) return 'Audio';
    if (documentExtensions.includes(ext)) return 'Document';
    if (codeExtensions.includes(ext)) return 'Code';
    if (archiveExtensions.includes(ext)) return 'Archive';

    return 'File';
}

/*
 * ============================================================
 * ATTRIBUTES
 * ============================================================
 */

function getAttributes(attributes) {
    let value = '';

    if (typeof attributes === 'string') {
        value = attributes;
    } else if (Array.isArray(attributes)) {
        value = attributes.join(' ');
    } else if (attributes) {
        value = String(attributes);
    }

    return {
        hidden: value.includes('Hidden'),
        readOnly: value.includes('ReadOnly'),
        system: value.includes('System')
    };
}

/*
 * ============================================================
 * SAFE DATE
 * ============================================================
 */

function safeDate(dateValue) {
    try {
        const date = new Date(dateValue);

        if (isNaN(date.getTime())) {
            return new Date(0);
        }

        return date;

    } catch {
        return new Date(0);
    }
}

/*
 * ============================================================
 * FORMAT BYTES
 * ============================================================
 */

function formatBytes(bytes) {
    if (!bytes || bytes <= 0) {
        return '0 B';
    }

    const units = [
        'B',
        'KB',
        'MB',
        'GB',
        'TB'
    ];

    const index = Math.min(
        Math.floor(
            Math.log(bytes) / Math.log(1024)
        ),
        units.length - 1
    );

    return `${(
        bytes / Math.pow(1024, index)
    ).toFixed(2)} ${units[index]}`;
}

/*
 * ============================================================
 * NETWORK PATH DETECTION
 * ============================================================
 *
 * Examples:
 *
 *   \\172.xx.xx.xxx\Downloads
 *   \\SERVER01\Share
 */

function isNetworkPath(sourcePath) {
    if (!sourcePath) {
        return false;
    }

    return (
        sourcePath.startsWith('\\\\')
    );
}

/*
 * ============================================================
 * CONCURRENCY
 * ============================================================
 */

function getScanConcurrency(networkPath) {

    const envName = networkPath
        ? 'NETWORK_SCAN_CONCURRENCY'
        : 'LOCAL_SCAN_CONCURRENCY';

    const raw = Number.parseInt(
        process.env[envName],
        10
    );

    if (Number.isFinite(raw)) {

        const max =
            networkPath
                ? MAX_NETWORK_CONCURRENCY
                : MAX_LOCAL_CONCURRENCY;

        return Math.min(
            Math.max(raw, 1),
            max
        );
    }

    return networkPath
        ? DEFAULT_NETWORK_CONCURRENCY
        : DEFAULT_LOCAL_CONCURRENCY;
}

/*
 * ============================================================
 * FILE CONCURRENCY
 * ============================================================
 *
 * We keep metadata operations controlled.
 */

function getFileConcurrency(networkPath) {

    const envName = networkPath
        ? 'NETWORK_FILE_CONCURRENCY'
        : 'LOCAL_FILE_CONCURRENCY';

    const raw = Number.parseInt(
        process.env[envName],
        10
    );

    if (Number.isFinite(raw)) {

        const max =
            networkPath
                ? MAX_NETWORK_CONCURRENCY
                : MAX_LOCAL_CONCURRENCY;

        return Math.min(
            Math.max(raw, 1),
            max
        );
    }

    return networkPath
        ? DEFAULT_NETWORK_CONCURRENCY
        : DEFAULT_LOCAL_CONCURRENCY;
}

/*
 * ============================================================
 * OUTPUT HELPERS
 * ============================================================
 */

async function ensureOutputFolder(outputFolder) {
    await fs.promises.mkdir(
        outputFolder,
        {
            recursive: true
        }
    );
}

async function saveJson(filePath, data) {
    await fs.promises.writeFile(
        filePath,
        JSON.stringify(data, null, 2),
        'utf8'
    );
}

/*
 * ============================================================
 * DRIVE INFORMATION
 * ============================================================
 */

async function getDriveInfo() {

    const drives = [];

    const letters =
        'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

    try {

        const powerShellPath =
            'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

        const script = `
Get-Volume -ErrorAction SilentlyContinue |
Where-Object { $_.DriveLetter -ne $null } |
Select-Object DriveLetter, FileSystem, Size, SizeRemaining |
ConvertTo-Json -Compress
`;

        const output = execFileSync(
            powerShellPath,
            [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                script
            ],
            {
                encoding: 'utf8',
                windowsHide: true,
                timeout: 30000,
                maxBuffer: 10 * 1024 * 1024
            }
        );

        if (output && output.trim()) {

            const parsed =
                JSON.parse(output);

            const volumes =
                Array.isArray(parsed)
                    ? parsed
                    : [parsed];

            for (const volume of volumes) {

                if (
                    !volume ||
                    !volume.DriveLetter
                ) {
                    continue;
                }

                const totalSpace =
                    Number(volume.Size) || 0;

                const freeSpace =
                    Number(volume.SizeRemaining) || 0;

                drives.push({
                    driveLetter:
                        `${volume.DriveLetter}:`,

                    fileSystemType:
                        volume.FileSystem ||
                        'Unknown',

                    totalSpace,

                    freeSpace,

                    usedSpace:
                        totalSpace -
                        freeSpace
                });
            }
        }

    } catch {
        console.warn(
            'Warning: Unable to collect Windows drive information.'
        );
    }

    /*
     * Fallback
     */

    for (const letter of letters) {

        const driveLetter =
            `${letter}:`;

        const drivePath =
            `${driveLetter}\\`;

        const alreadyExists =
            drives.some(
                drive =>
                    drive.driveLetter ===
                    driveLetter
            );

        if (alreadyExists) {
            continue;
        }

        try {

            await fs.promises.stat(
                drivePath
            );

            drives.push({
                driveLetter,

                fileSystemType:
                    'Unknown',

                totalSpace: 0,
                freeSpace: 0,
                usedSpace: 0
            });

        } catch {
            // Drive not present.
        }
    }

    return drives;
}

/*
 * ============================================================
 * VALIDATE SOURCE
 * ============================================================
 */

async function validateSourcePath(
    sourcePath
) {

    if (
        !sourcePath ||
        typeof sourcePath !== 'string'
    ) {
        throw new Error(
            'SOURCE_PATH is empty or invalid.'
        );
    }

    try {

        const stats =
            await fs.promises.stat(
                sourcePath
            );

        if (!stats.isDirectory()) {

            throw new Error(
                `SOURCE_PATH is not a directory: ${sourcePath}`
            );
        }

        return true;

    } catch (error) {

        if (error.code === 'ENOENT') {

            throw new Error(
                `Source path does not exist or is not reachable: ${sourcePath}`
            );
        }

        if (
            error.code === 'EACCES' ||
            error.code === 'EPERM'
        ) {

            throw new Error(
                `Access denied for source path: ${sourcePath}. Make sure the Windows account running Node.js has permission to access this network share.`
            );
        }

        throw new Error(
            `Cannot access source path '${sourcePath}': ${error.message}`
        );
    }
}

/*
 * ============================================================
 * FILE METADATA
 * ============================================================
 */

function createFileMetadata(
    fileName,
    fullPath,
    stats,
    basePath
) {

    const extension =
        path.extname(fileName);

    const modifiedDate =
        safeDate(stats.mtime);

    const createdDate =
        safeDate(stats.birthtime);

    const accessedDate =
        safeDate(stats.atime);

    const relativePath =
        path.relative(
            basePath,
            fullPath
        );

    const twentyFourHoursAgo =
        Date.now() -
        (24 * 60 * 60 * 1000);

    const recent =
        modifiedDate.getTime() >=
        twentyFourHoursAgo;

    return {

        name: fileName,

        fullPath,

        relativePath,

        extension,

        fileType:
            getFileType(extension),

        mimeType:
            getMimeType(extension),

        size:
            stats.size,

        sizeFormatted:
            formatBytes(stats.size),

        createdDate:
            createdDate.toISOString(),

        modifiedDate:
            modifiedDate.toISOString(),

        lastAccessedDate:
            accessedDate.toISOString(),

        parentFolder:
            path.dirname(fullPath),

        recent,

        attributes:
            getAttributes(stats)
    };
}

/*
 * ============================================================
 * FOLDER METADATA
 * ============================================================
 */

function createFolderMetadata(
    folderName,
    fullPath,
    stats,
    basePath
) {

    const modifiedDate =
        safeDate(stats.mtime);

    const createdDate =
        safeDate(stats.birthtime);

    const relativePath =
        path.relative(
            basePath,
            fullPath
        ) || '.';

    const twentyFourHoursAgo =
        Date.now() -
        (24 * 60 * 60 * 1000);

    const recent =
        modifiedDate.getTime() >=
        twentyFourHoursAgo;

    return {

        name: folderName,

        fullPath,

        relativePath,

        parentFolder:
            path.dirname(fullPath),

        createdDate:
            createdDate.toISOString(),

        modifiedDate:
            modifiedDate.toISOString(),

        fileCount: 0,

        subfolderCount: 0,

        recent,

        attributes:
            getAttributes(stats)
    };
}

/*
 * ============================================================
 * COLLECTION HELPERS
 * ============================================================
 */

function addCollectedFile(
    collected,
    item
) {

    if (item.recent) {

        collected.recentFiles.push(
            item
        );

    } else {

        collected.files.push(
            item
        );
    }
}

function addCollectedFolder(
    collected,
    item
) {

    if (item.recent) {

        collected.recentFolders.push(
            item
        );

    } else {

        collected.folders.push(
            item
        );
    }
}

/*
 * ============================================================
 * PROCESS ONE FILE
 * ============================================================
 *
 * Dirent already told us this is a file.
 *
 * Therefore there is NO:
 *
 *   stat() -> isFile()
 *
 * duplicate type check.
 *
 * We only perform stat because the output requires:
 *
 *   size
 *   createdDate
 *   modifiedDate
 *   lastAccessedDate
 */

async function processFile(
    fullPath,
    basePath,
    collected,
    counters
) {

    try {

        const stats =
            await fs.promises.stat(
                fullPath
            );

        /*
         * Very rare case where entry changed
         * between readdir and stat.
         */

        if (!stats.isFile()) {
            return;
        }

        const fileData =
            createFileMetadata(
                path.basename(fullPath),
                fullPath,
                stats,
                basePath
            );

        addCollectedFile(
            collected,
            fileData
        );

        counters.files++;

        if (
            counters.files % 1000 === 0
        ) {

            console.log(
                `Progress: ${counters.files} files, ${counters.folders} folders`
            );
        }

    } catch (error) {

        counters.errors++;

        collected.errors.push({
            path: fullPath,

            error:
                error.message,

            code:
                error.code || null
        });
    }
}

/*
 * ============================================================
 * PROCESS FILE BATCH
 * ============================================================
 */

async function processFileBatch(
    filePaths,
    basePath,
    collected,
    counters,
    fileConcurrency
) {

    /*
     * Process files in smaller groups.
     *
     * Example:
     *
     * 64 files
     * ↓
     * 16 concurrent
     * ↓
     * next 16
     * ↓
     * ...
     */

    for (
        let index = 0;
        index < filePaths.length;
        index += fileConcurrency
    ) {

        const batch =
            filePaths.slice(
                index,
                index + fileConcurrency
            );

        await Promise.all(
            batch.map(
                filePath =>
                    processFile(
                        filePath,
                        basePath,
                        collected,
                        counters
                    )
            )
        );
    }
}

/*
 * ============================================================
 * PROCESS DIRECTORY
 * ============================================================
 *
 * IMPORTANT:
 *
 * readdir({ withFileTypes: true })
 * returns Dirent.
 *
 * We use:
 *
 *   isDirectory()
 *   isFile()
 *   isSymbolicLink()
 *
 * without stat just to determine entry type.
 *
 * This saves unnecessary filesystem calls.
 */

async function processDirectory(
    currentPath,
    basePath,
    collected,
    counters,
    fileConcurrency
) {

    let entries;

    try {

        entries =
            await fs.promises.readdir(
                currentPath,
                {
                    withFileTypes: true
                }
            );

    } catch (error) {

        counters.errors++;

        collected.errors.push({
            path: currentPath,

            error:
                `Unable to read directory: ${error.message}`,

            code:
                error.code || null
        });

        return [];
    }

    const childDirectories = [];
    const childFiles = [];

    /*
     * ========================================================
     * FAST DIRent CLASSIFICATION
     * ========================================================
     */

    for (const entry of entries) {

        if (
            !entry ||
            !entry.name
        ) {
            continue;
        }

        const fullPath =
            path.join(
                currentPath,
                entry.name
            );

        /*
         * Symbolic link
         */

        if (entry.isSymbolicLink()) {

            counters.skipped++;

            continue;
        }

        /*
         * Directory
         */

        if (entry.isDirectory()) {

            /*
             * We need directory timestamps
             * for folders.json.
             *
             * Therefore one stat is required.
             */

            try {

                const stats =
                    await fs.promises.stat(
                        fullPath
                    );

                if (!stats.isDirectory()) {
                    continue;
                }

                const folderData =
                    createFolderMetadata(
                        entry.name,
                        fullPath,
                        stats,
                        basePath
                    );

                addCollectedFolder(
                    collected,
                    folderData
                );

                counters.folders++;

                childDirectories.push(
                    fullPath
                );

            } catch (error) {

                counters.errors++;

                collected.errors.push({
                    path: fullPath,

                    error:
                        error.message,

                    code:
                        error.code || null
                });
            }

            continue;
        }

        /*
         * File
         */

        if (entry.isFile()) {

            childFiles.push(
                fullPath
            );
        }
    }

    /*
     * ========================================================
     * FILE METADATA
     * ========================================================
     */

    if (childFiles.length > 0) {

        await processFileBatch(
            childFiles,
            basePath,
            collected,
            counters,
            fileConcurrency
        );
    }

    return childDirectories;
}

/*
 * ============================================================
 * MAIN SCAN
 * ============================================================
 */

async function scanPath(
    sourcePath,
    outputFolder
) {

    const startTime =
        Date.now();

    const networkPath =
        isNetworkPath(sourcePath);

    const directoryConcurrency =
        getScanConcurrency(
            networkPath
        );

    const fileConcurrency =
        getFileConcurrency(
            networkPath
        );

    console.log('');

    console.log(
        '=================================================='
    );

    console.log(
        'Starting Windows File System scan...'
    );

    console.log(
        '=================================================='
    );

    console.log(
        `Source: ${sourcePath}`
    );

    console.log(
        `Source Type: ${
            networkPath
                ? 'NETWORK / SMB'
                : 'LOCAL FILESYSTEM'
        }`
    );

    console.log(
        `Directory Concurrency: ${directoryConcurrency}`
    );

    console.log(
        `File Metadata Concurrency: ${fileConcurrency}`
    );

    await validateSourcePath(
        sourcePath
    );

    console.log(
        'Source path is accessible.'
    );

    console.log(
        'Scanning directory...'
    );

    console.log(
        'Using readdir + Dirent + bounded workers + minimum filesystem calls.'
    );

    /*
     * ========================================================
     * COLLECTION
     * ========================================================
     */

    const collected = {

        files: [],

        recentFiles: [],

        folders: [],

        recentFolders: [],

        errors: []
    };

    const counters = {

        files: 0,

        folders: 0,

        errors: 0,

        skipped: 0
    };

    /*
     * ========================================================
     * DIRECTORY QUEUE
     * ========================================================
     *
     * Instead of multiple workers doing:
     *
     * queue.shift()
     *
     * and potentially exiting when queue temporarily
     * becomes empty, we process directories in bounded
     * waves.
     *
     * This is predictable and avoids a queue race.
     */

    let directoryQueue = [
        sourcePath
    ];

    let waveNumber = 0;

    while (
        directoryQueue.length > 0
    ) {

        waveNumber++;

        const currentWave =
            directoryQueue;

        directoryQueue = [];

        /*
         * Process only N directories simultaneously.
         */

        for (
            let index = 0;
            index < currentWave.length;
            index += directoryConcurrency
        ) {

            const directoryBatch =
                currentWave.slice(
                    index,
                    index + directoryConcurrency
                );

            const results =
                await Promise.all(
                    directoryBatch.map(
                        directoryPath =>
                            processDirectory(
                                directoryPath,
                                sourcePath,
                                collected,
                                counters,
                                fileConcurrency
                            )
                    )
                );

            /*
             * Add discovered child directories
             * to the next wave.
             */

            for (
                const childDirectories of results
            ) {

                if (
                    childDirectories &&
                    childDirectories.length > 0
                ) {

                    directoryQueue.push(
                        ...childDirectories
                    );
                }
            }

            /*
             * Progress output.
             */

            console.log(
                `Progress: ${counters.files} files, ${counters.folders} folders | Directory wave ${waveNumber}`
            );
        }
    }

    /*
     * ========================================================
     * SCAN COMPLETE
     * ========================================================
     */

    const scanDurationMs =
        Date.now() -
        startTime;

    console.log('');

    console.log(
        '=================================================='
    );

    console.log(
        'Scan completed'
    );

    console.log(
        '=================================================='
    );

    console.log(
        `Files found: ${counters.files}`
    );

    console.log(
        `Folders found: ${counters.folders}`
    );

    console.log(
        `Errors: ${counters.errors}`
    );

    console.log(
        `Skipped symbolic links: ${counters.skipped}`
    );

    console.log(
        `Duration: ${(scanDurationMs / 1000).toFixed(2)} seconds`
    );

    console.log(
        `Directory concurrency: ${directoryConcurrency}`
    );

    console.log(
        `File concurrency: ${fileConcurrency}`
    );

    /*
     * ========================================================
     * OUTPUT FOLDER
     * ========================================================
     */

    await ensureOutputFolder(
        outputFolder
    );

    /*
     * ========================================================
     * SERVER INFO
     * ========================================================
     */

    const serverInfo = {

        hostname:
            os.hostname(),

        platform:
            os.platform(),

        arch:
            os.arch(),

        osRelease:
            os.release(),

        osType:
            os.type(),

        totalMemory:
            os.totalmem(),

        freeMemory:
            os.freemem(),

        scanTime:
            new Date().toISOString(),

        scanDurationMs,

        itemsScanned:
            counters.files +
            counters.folders,

        sourcePath,

        sourceIsFile:
            false,

        scanMethod:
            'readdir + Dirent + network-aware bounded workers + minimum filesystem calls',

        networkPath,

        directoryConcurrency,

        fileConcurrency,

        fileCount:
            counters.files,

        folderCount:
            counters.folders,

        errorCount:
            counters.errors,

        skippedCount:
            counters.skipped
    };

    await saveJson(
        path.join(
            outputFolder,
            'server.json'
        ),
        serverInfo
    );

    /*
     * ========================================================
     * DRIVES
     * ========================================================
     */

    console.log(
        'Collecting drive information...'
    );

    const drives =
        await getDriveInfo();

    await saveJson(
        path.join(
            outputFolder,
            'drives.json'
        ),
        {
            drives
        }
    );

    /*
     * ========================================================
     * FOLDERS
     * ========================================================
     */

    await saveJson(
        path.join(
            outputFolder,
            'folders.json'
        ),
        {
            folders:
                collected.folders,

            total:
                collected.folders.length
        }
    );

    /*
     * ========================================================
     * FILES
     * ========================================================
     */

    await saveJson(
        path.join(
            outputFolder,
            'files.json'
        ),
        {
            files:
                collected.files,

            total:
                collected.files.length
        }
    );

    /*
     * ========================================================
     * RECENT
     * ========================================================
     */

    await saveJson(
        path.join(
            outputFolder,
            'recent.json'
        ),
        {
            files:
                collected.recentFiles,

            folders:
                collected.recentFolders,

            totalFiles:
                collected.recentFiles.length,

            totalFolders:
                collected.recentFolders.length
        }
    );

    /*
     * ========================================================
     * PERMISSIONS
     * ========================================================
     */

    await saveJson(
        path.join(
            outputFolder,
            'permissions.json'
        ),
        {
            permissions: [],

            collected: false,

            note:
                'File system metadata collected. NTFS/share permissions are not collected in this scan.'
        }
    );

    /*
     * ========================================================
     * ERRORS
     * ========================================================
     */

    if (
        collected.errors.length > 0
    ) {

        await saveJson(
            path.join(
                outputFolder,
                'errors.json'
            ),
            {
                errors:
                    collected.errors,

                total:
                    collected.errors.length
            }
        );

    } else {

        try {

            await fs.promises.unlink(
                path.join(
                    outputFolder,
                    'errors.json'
                )
            );

        } catch {
            // errors.json does not exist.
        }
    }

    console.log('');

    console.log(
        'Metadata saved successfully.'
    );

    console.log(
        `Output folder: ${outputFolder}`
    );

    /*
     * ========================================================
     * RESULT
     * ========================================================
     */

    return {

        sourcePath,

        outputFolder,

        fileCount:
            collected.files.length,

        recentCount:
            collected.recentFiles.length,

        folderCount:
            collected.folders.length,

        recentFolderCount:
            collected.recentFolders.length,

        permissionsCollected:
            false,

        scanDurationMs,

        totalItemsScanned:
            counters.files +
            counters.folders
    };
}

/*
 * ============================================================
 * DOWNLOAD FILES
 * ============================================================
 *
 * Download logic remains functionally the same.
 */

async function downloadFiles(
    searchPath,
    outputFolder,
    downloadFolder
) {

    if (
        !searchPath ||
        typeof searchPath !== 'string'
    ) {

        throw new Error(
            'Filename is required.'
        );
    }

    const filesJsonPath =
        path.join(
            outputFolder,
            'files.json'
        );

    const recentJsonPath =
        path.join(
            outputFolder,
            'recent.json'
        );

    let allFiles = [];

    /*
     * files.json
     */

    try {

        const content =
            await fs.promises.readFile(
                filesJsonPath,
                'utf8'
            );

        const data =
            JSON.parse(content);

        if (
            Array.isArray(data.files)
        ) {

            allFiles =
                allFiles.concat(
                    data.files
                );
        }

    } catch {
        // Ignore missing file.
    }

    /*
     * recent.json
     */

    try {

        const content =
            await fs.promises.readFile(
                recentJsonPath,
                'utf8'
            );

        const data =
            JSON.parse(content);

        if (
            Array.isArray(data.files)
        ) {

            allFiles =
                allFiles.concat(
                    data.files
                );
        }

    } catch {
        // Ignore missing file.
    }

    if (
        allFiles.length === 0
    ) {

        throw new Error(
            `No files found in ${outputFolder}. Run 'collect' command first.`
        );
    }

    await fs.promises.mkdir(
        downloadFolder,
        {
            recursive: true
        }
    );

    /*
     * Exact filename matching
     */

    const matched =
        allFiles.filter(
            file =>
                file &&
                typeof file.name === 'string' &&
                file.name.toLowerCase() ===
                    searchPath.toLowerCase()
        );

    if (
        matched.length === 0
    ) {

        console.log(
            `File '${searchPath}' not found in metadata.`
        );

        return {

            matched: 0,

            downloaded: 0,

            failed: 0,

            downloadFolder,

            skipped: 0
        };
    }

    console.log('');

    console.log(
        `Found ${matched.length} matching file(s).`
    );

    let downloaded = 0;
    let failed = 0;
    let skipped = 0;

    /*
     * Copy files
     */

    for (
        let index = 0;
        index < matched.length;
        index++
    ) {

        const file =
            matched[index];

        try {

            if (!file.fullPath) {

                failed++;

                console.log(
                    `Failed: ${file.name} - path missing`
                );

                continue;
            }

            /*
             * Verify source
             */

            try {

                await fs.promises.access(
                    file.fullPath
                );

            } catch {

                failed++;

                console.log(
                    `Failed: ${file.fullPath} - source file not accessible`
                );

                continue;
            }

            let targetFileName =
                file.name;

            let destination =
                path.join(
                    downloadFolder,
                    targetFileName
                );

            /*
             * Avoid overwrite
             */

            let counter = 1;

            while (true) {

                try {

                    await fs.promises.access(
                        destination
                    );

                    const extension =
                        path.extname(
                            file.name
                        );

                    const baseName =
                        path.basename(
                            file.name,
                            extension
                        );

                    targetFileName =
                        `${baseName} (${counter})${extension}`;

                    destination =
                        path.join(
                            downloadFolder,
                            targetFileName
                        );

                    counter++;

                } catch {

                    break;
                }
            }

            /*
             * Copy
             */

            await fs.promises.copyFile(
                file.fullPath,
                destination
            );

            downloaded++;

            console.log(
                `Downloaded: ${file.fullPath}`
            );

            console.log(
                `Saved as: ${destination}`
            );

        } catch (error) {

            failed++;

            console.log(
                `Failed: ${file.fullPath || file.name}`
            );

            console.log(
                `Reason: ${error.message}`
            );
        }
    }

    return {

        matched:
            matched.length,

        downloaded,

        failed,

        downloadFolder,

        skipped
    };
}

/*
 * ============================================================
 * EXPORTS
 * ============================================================
 */

module.exports = {
    scanPath,
    downloadFiles
};