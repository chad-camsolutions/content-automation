/**
 * LinkedIn Voyager API Helper
 * Direct HTTP requests to LinkedIn's internal API using session cookie
 * Much faster than browser automation, bypasses official API permission issues
 */

const https = require('https');

class VoyagerClient {
    constructor(cookie) {
        if (!cookie) throw new Error('VoyagerClient requires li_at cookie');
        this.cookie = cookie;
        this.headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Cookie': `li_at=${cookie};`,
            'Csrf-Token': this.extractCsrf(cookie),
            'X-Restli-Protocol-Version': '2.0.0',
            'x-li-lang': 'en_US',
            'accept': 'application/vnd.linkedin.normalized+json+2.1'
        };
    }

    extractCsrf(cookie) {
        // Debugging cookie format
        if (cookie.length < 20) console.warn('Warning: Cookie seems very short!');

        // Match JSESSIONID
        const match = cookie.match(/JSESSIONID="([^"]+)"/);

        if (match) {
            console.log('Extracted CSRF token from JSESSIONID');
            return match[1];
        }

        // Fallback or Try to parse it if it's without quotes
        const matchSimple = cookie.match(/JSESSIONID=([^;]+)/);
        if (matchSimple) {
            console.log('Extracted CSRF token from JSESSIONID (simple format)');
            return matchSimple[1].replace(/"/g, '');
        }

        console.warn('Could not extract JSESSIONID from cookie string. Using hardcoded fallback (likely to fail 403).');
        return 'ajax:4624395368366964243';
    }

    async getMyself() {
        const data = await this.request('https://www.linkedin.com/voyager/api/me');
        // miniProfile: { entityUrn: "urn:li:fs_miniProfile:ACoAA...", ... }
        return data;
    }

    async getRecentActivity(publicIdentifier) {
        // If we don't have publicIdentifier (like "chad-van-der-walt..."), we might need to fetch it first
        // But better is to search by URN.
        // Let's assume we fetch "me" first to get URN.
        const me = await this.getMyself();
        const urn = me.miniProfile.entityUrn.split(':').pop(); // e.g. "ACoAA..." or numeric ID

        // Use the profileUpdates endpoint
        // URL: /voyager/api/identity/profileUpdatesV2?count=40&includeLongTermHistory=true&moduleKey=member-shares:phone&q=memberShareFeed&start=0&profileUrn=urn:li:fs_miniProfile:<ID>
        const url = `https://www.linkedin.com/voyager/api/identity/profileUpdatesV2?count=40&includeLongTermHistory=true&moduleKey=member-shares:phone&q=memberShareFeed&start=0&profileUrn=${me.miniProfile.entityUrn}`;

        return await this.request(url);
    }

    request(url) {
        return new Promise((resolve, reject) => {
            const req = https.get(url, { headers: this.headers }, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(JSON.parse(data));
                        } catch (e) {
                            reject(new Error(`Failed to parse Voyager response: ${e.message}`));
                        }
                    } else {
                        reject(new Error(`Voyager API Error: ${res.statusCode} ${res.statusMessage}`));
                    }
                });
            });
            req.on('error', reject);
            req.end();
        });
    }
}

module.exports = VoyagerClient;
