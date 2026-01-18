/**
 * Post to LinkedIn
 * Reads pending posts from Google Sheet, posts to LinkedIn API
 */

const sheets = require('./sheets-helper');

const BATCH_SIZE = 2; // Posts per run (12 runs/day = 24 posts, under 25 limit)

async function main() {
    console.log('Starting LinkedIn posting batch...');

    const accessToken = process.env.LINKEDIN_ACCESS_TOKEN;
    if (!accessToken) {
        throw new Error('LINKEDIN_ACCESS_TOKEN not set');
    }

    // Get user URN (needed for posting)
    const userUrn = await getLinkedInUserUrn(accessToken);
    console.log(`Posting as: ${userUrn}`);

    // Get pending posts
    const pending = await sheets.getPendingPosts('LinkedIn Queue', BATCH_SIZE);
    console.log(`Found ${pending.length} pending posts`);

    if (pending.length === 0) {
        console.log('No pending posts. Add more to the LinkedIn Queue tab.');
        return;
    }

    // Post each one
    let successCount = 0;
    for (const post of pending) {
        try {
            console.log(`Posting: "${post.content.substring(0, 50)}..."`);

            // Post to LinkedIn
            const postId = await postToLinkedIn(accessToken, userUrn, post.content);

            console.log(`Posted! Post ID: ${postId}`);

            // Mark as posted in sheet
            await sheets.markAsPosted('LinkedIn Queue', post.rowIndex, postId);
            successCount++;

            // Delay between posts
            await sleep(3000);

        } catch (error) {
            console.error(`Failed to post row ${post.rowIndex}:`, error.message);

            // Check for rate limit
            if (error.message.includes('429') || error.message.includes('throttle')) {
                console.error('Rate limited! Stopping batch.');
                break;
            }
        }
    }

    console.log(`Batch complete. Posted ${successCount}/${pending.length} successfully.`);
}

async function getLinkedInUserUrn(accessToken) {
    const response = await fetch('https://api.linkedin.com/v2/userinfo', {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
    });

    if (!response.ok) {
        throw new Error(`LinkedIn API error: ${response.status}`);
    }

    const data = await response.json();
    return `urn:li:person:${data.sub}`;
}

async function postToLinkedIn(accessToken, userUrn, content) {
    const response = await fetch('https://api.linkedin.com/v2/ugcPosts', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'X-Restli-Protocol-Version': '2.0.0'
        },
        body: JSON.stringify({
            author: userUrn,
            lifecycleState: 'PUBLISHED',
            specificContent: {
                'com.linkedin.ugc.ShareContent': {
                    shareCommentary: {
                        text: content
                    },
                    shareMediaCategory: 'NONE'
                }
            },
            visibility: {
                'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'
            }
        })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`LinkedIn post failed: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.id;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(console.error);
