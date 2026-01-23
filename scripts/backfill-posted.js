const sheets = require('./sheets-helper');

async function backfill(platform) {
    const queueTab = `${platform} Queue`;
    const postedTab = `${platform} Posted`;

    console.log(`\nBackfilling ${platform}...`);

    try {
        const queueRows = await sheets.getRawRows(queueTab);
        const postedRows = await sheets.getRawRows(postedTab);

        if (queueRows.length <= 1) {
            console.log('No data in queue.');
            return;
        }

        // Get headers
        const headers = queueRows[0];
        const statusIdx = headers.indexOf('Status');
        const idIdx = headers.indexOf('Platform Post ID');

        if (statusIdx === -1 || idIdx === -1) {
            console.error(`Could not find required columns in ${queueTab}`);
            return;
        }

        // Build set of existing IDs in Posted tab
        const postedIds = new Set();
        if (postedRows.length > 1) {
            const pHeaders = postedRows[0];
            const pIdIdx = pHeaders.indexOf('Platform Post ID');
            if (pIdIdx !== -1) {
                postedRows.slice(1).forEach(row => {
                    const id = row[pIdIdx];
                    if (id) postedIds.add(id);
                });
            }
        }
        console.log(`Found ${postedIds.size} existing posted items in ${postedTab}.`);

        let copied = 0;
        // Iterate Queue
        for (let i = 1; i < queueRows.length; i++) {
            const row = queueRows[i];
            const status = row[statusIdx];
            const platformId = row[idIdx];

            if (status === 'Posted' && platformId) {
                if (!postedIds.has(platformId)) {
                    console.log(`Copying row ${i + 1} (${platformId}) to ${postedTab}...`);
                    await sheets.copyRowToTab(queueTab, postedTab, i + 1);
                    postedIds.add(platformId); // prevent dupes if dupes in queue
                    copied++;
                    // Basic rate limiting
                    await new Promise(r => setTimeout(r, 800));
                }
            }
        }
        console.log(`Backfilled ${copied} items for ${platform}.`);

    } catch (error) {
        console.error(`Error backfilling ${platform}:`, error.message);
    }
}

async function main() {
    console.log('Starting backfill process...');
    await backfill('X');
    await backfill('LinkedIn');
    console.log('\nBackfill complete.');
}

main().catch(console.error);
