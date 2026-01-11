import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock the environment
const BACKUP_FILE = path.join(os.homedir(), '.anti-quota', 'state_backup.json');

function testExtraction() {
    console.log('Testing Chat Session Extraction...');

    if (!fs.existsSync(BACKUP_FILE)) {
        console.log('No backup file found at', BACKUP_FILE);
        return;
    }

    const backupContent = fs.readFileSync(BACKUP_FILE, 'utf-8');
    const backupData = JSON.parse(backupContent);
    const trajBase64 = backupData['antigravityUnifiedStateSync.trajectorySummaries'];

    if (!trajBase64) {
        console.log('No trajectory summaries found in backup');
        return;
    }

    const buf = Buffer.from(trajBase64, 'base64');
    const uuidRegex = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi;
    const text = buf.toString('utf-8');
    const matches = text.match(uuidRegex);

    if (matches && matches.length > 0) {
        console.log(`Found ${matches.length} UUIDs.`);
        console.log('First UUID:', matches[0]);
        console.log('Last UUID:', matches[matches.length - 1]);

        const latest = matches[matches.length - 1];
        console.log('SUCCESS: "Latest" (last) UUID is:', latest);
    } else {
        console.log('No UUIDs found in the blob.');
    }
}

testExtraction();
