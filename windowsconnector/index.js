const { scanPath, downloadFiles } = require('./service');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

require('dotenv').config();

const argv = yargs(hideBin(process.argv))
    .command('collect', 'Collect metadata from source path')
    .command('download', 'Download file by exact filename')
    .demandCommand(1, 'Specify a command: collect or download')
    .help()
    .argv;

const sourcePath = process.env.SOURCE_PATH;
const outputFolder = process.env.OUTPUT_FOLDER || 'WindowsFileSystemData';

async function main() {
    const command = argv._[0];

    if (command === 'collect') {
        if (!sourcePath) {
            console.error('ERROR: SOURCE_PATH is not configured in .env');
            process.exit(1);
        }

        try {
            const result = await scanPath(
                sourcePath,
                outputFolder
            );

            console.log('');
            console.log('='.repeat(50));
            console.log('Scan Results:');
            console.log('='.repeat(50));

            console.log(`Source: ${result.sourcePath}`);
            console.log(`Total Items Scanned: ${result.totalItemsScanned}`);
            console.log(`Files Found: ${result.fileCount}`);
            console.log(`Recent Files (24h): ${result.recentCount}`);
            console.log(`Folders Found: ${result.folderCount}`);
            console.log(`Recent Folders (24h): ${result.recentFolderCount}`);

            console.log(
                `Scan Duration: ${result.scanDurationMs} ms (${(
                    result.scanDurationMs / 1000
                ).toFixed(2)} seconds)`
            );

            console.log(`Output: .\\${result.outputFolder}`);

        } catch (err) {
            console.error('');
            console.error('ERROR: ' + err.message);
            process.exit(1);
        }

    } else if (command === 'download') {

        const filename = argv._[1];

        if (!filename) {
            console.error('ERROR: Specify filename to download');
            console.log('Usage: npm start download "filename"');
            process.exit(1);
        }

        const downloadsFolder =
            `${outputFolder}/downloads`;

        try {
            const result = await downloadFiles(
                filename,
                outputFolder,
                downloadsFolder
            );

            console.log('');
            console.log('='.repeat(50));
            console.log('Download Results:');
            console.log('='.repeat(50));

            console.log(`Filename: ${filename}`);
            console.log(`Files Downloaded: ${result.downloaded}`);
            console.log(`Output: .\\${result.downloadFolder}`);

            if (result.skipped > 0) {
                console.log(
                    `Skipped (already exists): ${result.skipped}`
                );
            }

            if (result.failed > 0) {
                console.log(
                    `Failed: ${result.failed}`
                );
            }

        } catch (err) {
            console.error('');
            console.error('ERROR: ' + err.message);
            process.exit(1);
        }
    }
}

main();