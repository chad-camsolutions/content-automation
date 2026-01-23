/**
 * Google Sheets Helper
 * Utilities for reading/writing to the content queue sheet
 */

const { google } = require('googleapis');

// Initialize auth from service account JSON in environment
function getAuth() {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
    return new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
}

// Get sheets client
async function getSheetsClient() {
    const auth = await getAuth();
    return google.sheets({ version: 'v4', auth });
}

/**
 * Get pending posts from a queue tab
 * @param {string} tabName - e.g., 'X Queue' or 'LinkedIn Queue'
 * @param {number} limit - How many to fetch
 * @returns {Array} Array of post objects
 */
async function getPendingPosts(tabName, limit = 7) {
    const sheets = await getSheetsClient();
    const spreadsheetId = process.env.SPREADSHEET_ID;

    // Get all rows from queue
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${tabName}'!A:J`
    });

    const rows = response.data.values || [];
    if (rows.length <= 1) return []; // Only headers or empty

    const headers = rows[0];
    const pending = [];

    for (let i = 1; i < rows.length && pending.length < limit; i++) {
        const row = rows[i];
        const status = row[headers.indexOf('Status')] || '';

        if (status.toLowerCase() === 'pending') {
            pending.push({
                rowIndex: i + 1, // 1-indexed for Sheets
                postId: row[headers.indexOf('Post ID')] || `post-${i}`,
                content: row[headers.indexOf('Content')] || '',
                scheduledTime: row[headers.indexOf('Scheduled Time')] || ''
            });
        }
    }

    return pending;
}

/**
 * Copy a row to another tab (append)
 */
async function copyRowToTab(sourceTab, targetTab, rowIndex) {
    const sheets = await getSheetsClient();
    const spreadsheetId = process.env.SPREADSHEET_ID;

    // Get the row data (cols A through J)
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${sourceTab}'!A${rowIndex}:J${rowIndex}`
    });

    const rowValues = response.data.values;
    if (!rowValues || rowValues.length === 0) return;

    // Append to target tab
    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `'${targetTab}'!A:A`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
            values: rowValues
        }
    });

    console.log(`Copied row ${rowIndex} from ${sourceTab} to ${targetTab}`);
}

/**
 * Mark a post as posted and copy to Posted tab
 * @param {string} tabName - Queue tab name
 * @param {number} rowIndex - Row to update
 * @param {string} platformPostId - ID from X/LinkedIn
 */
async function markAsPosted(tabName, rowIndex, platformPostId) {
    const sheets = await getSheetsClient();
    const spreadsheetId = process.env.SPREADSHEET_ID;

    // Update Status, Posted At, and Platform Post ID columns
    // Assuming: Status=C, Posted At=E, Platform Post ID=F
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${tabName}'!C${rowIndex}:F${rowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
            values: [['Posted', new Date().toISOString(), platformPostId]]
        }
    });

    console.log(`Marked row ${rowIndex} as posted with ID ${platformPostId}`);

    // Copy to Posted tab immediately
    // e.g. 'X Queue' -> 'X Posted'
    const postedTabName = tabName.replace('Queue', 'Posted');
    try {
        await copyRowToTab(tabName, postedTabName, rowIndex);
    } catch (error) {
        console.error(`Failed to copy to ${postedTabName}:`, error.message);
    }
}

/**
 * Get posts that need stats (posted 24+ hours ago, no stats yet)
 * @param {string} postedTabName - e.g., 'X Posted'
 * @returns {Array} Posts needing stats
 */
async function getPostsNeedingStats(postedTabName) {
    const sheets = await getSheetsClient();
    const spreadsheetId = process.env.SPREADSHEET_ID;

    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${postedTabName}'!A:J`
    });

    const rows = response.data.values || [];
    if (rows.length <= 1) return [];

    const headers = rows[0];
    const needStats = [];
    const now = new Date();

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const postedAt = row[headers.indexOf('Posted At')] || '';
        const impressions = row[headers.indexOf('Impressions')] || '';

        if (postedAt && !impressions) {
            const postedDate = new Date(postedAt);
            const hoursSincePost = (now - postedDate) / (1000 * 60 * 60);

            if (hoursSincePost >= 1) {
                needStats.push({
                    rowIndex: i + 1,
                    platformPostId: row[headers.indexOf('Platform Post ID')] || ''
                });
            }
        }
    }

    return needStats;
}

/**
 * Write stats for a post
 */
async function writeStats(postedTabName, rowIndex, stats) {
    const sheets = await getSheetsClient();
    const spreadsheetId = process.env.SPREADSHEET_ID;

    // Assuming: Impressions=G, Engagement=H, Engagement Rate=I, Winner=J
    const engagementRate = stats.impressions > 0
        ? ((stats.engagement / stats.impressions) * 100).toFixed(2) + '%'
        : '0%';

    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${postedTabName}'!G${rowIndex}:J${rowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
            values: [[
                stats.impressions,
                stats.engagement,
                engagementRate,
                stats.isWinner ? '🏆' : ''
            ]]
        }
    });
}

/**
 * Get average engagement for winner calculation
 */
async function getAverageEngagement(postedTabName) {
    const sheets = await getSheetsClient();
    const spreadsheetId = process.env.SPREADSHEET_ID;

    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${postedTabName}'!H:H` // Engagement column
    });

    const values = response.data.values || [];
    const numbers = values.slice(1) // Skip header
        .map(row => parseFloat(row[0]) || 0)
        .filter(n => n > 0);

    if (numbers.length === 0) return 0;
    return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

/**
 * Get all raw rows from a tab
 */
async function getRawRows(tabName) {
    const sheets = await getSheetsClient();
    const spreadsheetId = process.env.SPREADSHEET_ID;
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${tabName}'!A:J`
    });
    return response.data.values || [];
}

module.exports = {
    getPendingPosts,
    markAsPosted,
    getPostsNeedingStats,
    writeStats,
    getAverageEngagement,
    copyRowToTab,
    getRawRows
};
