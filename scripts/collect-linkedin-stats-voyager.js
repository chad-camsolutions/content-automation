/**
 * Collect LinkedIn Stats (Voyager API Method)
 * FAST and reliable, uses internal API endpoints via cookie
 */

const sheets = require('./sheets-helper');
const VoyagerClient = require('./voyager-client');

async function main() {
    console.log('Starting LinkedIn stats collection (Voyager API)...');

    const cookie = process.env.LINKEDIN_SESSION_COOKIE;
    if (!cookie) throw new Error('LINKEDIN_SESSION_COOKIE is required');

    const client = new VoyagerClient(cookie);

    try {
        console.log('Fetching user profile...');
        const me = await client.getMyself();
        console.log(`Logged in as: ${me.miniProfile.firstName} ${me.miniProfile.lastName}`);

        console.log('Fetching recent activity feed...');
        const feed = await client.getRecentActivity();

        // Feed elements handling
        let elements = feed.elements || [];
        if (feed.included) {
            // detailed activity often comes in 'included' array in Voyager v2
            // BUT for profileUpdatesV2, 'elements' usually contains the Update objects
            // Let's stick to elements for now.
        }

        console.log(`Found ${elements.length} feed items`);

        // Parse feed items into usable stats map
        const postStats = new Map();

        if (elements) {
            elements.forEach(item => {
                // Determine URN
                // Usually item.urn is like "urn:li:update:..." or "urn:li:activity:..."
                // However, detailed stats are often in the socialDetail object inside.

                let urn = item.urn;
                let socialDetail = item.socialDetail;
                let commentary = item.commentary;

                // Sometimes the item IS the update, sometimes it wraps it.
                // For profileUpdatesV2, item usually has { "socialDetail": { ... }, "urn": "..." } directly

                if (socialDetail) {
                    const stats = {
                        likes: socialDetail.totalSocialActivityCounts?.numLikes || 0,
                        comments: socialDetail.totalSocialActivityCounts?.numComments || 0,
                        impressions: 0 // Voyager feed rarely shows impressions publicly
                    };

                    // Add by FULL URN
                    if (urn) postStats.set(urn, stats);

                    // Add by simple ID (numeric part)
                    if (urn) {
                        const numericId = urn.split(':').pop();
                        postStats.set(numericId, stats);
                    }

                    // Add by content snippet (fallback)
                    if (commentary && commentary.text && commentary.text.text) {
                        const key = commentary.text.text.substring(0, 50).trim();
                        postStats.set(key, stats);
                    }
                }
            });
        }

        console.log(`Parsed stats for ${postStats.size} keys`);

        // Get sheet rows
        const postsNeedingStats = await sheets.getPostsNeedingStats('LinkedIn Posted');
        console.log(`${postsNeedingStats.length} posts in sheet need stats`);

        if (postsNeedingStats.length === 0) {
            console.log('No posts needing stats. Exiting.');
            return;
        }

        const avgEngagement = await sheets.getAverageEngagement('LinkedIn Posted');
        console.log(`Average Engagement: ${avgEngagement.toFixed(1)}`);

        // Update sheet
        let updatedCount = 0;
        for (const post of postsNeedingStats) {
            console.log(`Checking post row ${post.rowIndex}... for ID: ${post.platformPostId}`);

            let match = null;

            // 1. Try URN match (ID)
            if (post.platformPostId) {
                const id = post.platformPostId.split(':').pop();
                match = postStats.get(id);
                if (!match && postStats.has(post.platformPostId)) match = postStats.get(post.platformPostId);
            }

            // 2. Content match (if no ID match)
            if (!match) {
                const sheetContent = await sheets.getRawRows('LinkedIn Posted');
                // RowIndex is 1-based, array is 0-based.
                // sheetContent[0] is header. sheetContent[1] is Row 2.
                // So RowIndex 2 -> sheetContent[1].
                const rowData = sheetContent[post.rowIndex - 1];
                const content = rowData ? rowData[1] : ''; // Column B is Content

                if (content) {
                    const cleanContent = content.substring(0, 50).trim();
                    match = postStats.get(cleanContent);
                    if (match) console.log(`  -> Matched by Content snippet: "${cleanContent}..."`);
                }
            }

            if (match) {
                const engagement = (match.likes || 0) + (match.comments || 0);
                // Flag winner if > 0 and >= 2x Average
                const isWinner = engagement > 0 && engagement >= (avgEngagement * 2);

                console.log(`  -> Match found! Likes: ${match.likes}, Comments: ${match.comments}. Winner: ${isWinner}`);

                await sheets.writeStats('LinkedIn Posted', post.rowIndex, {
                    impressions: match.impressions || 0, // Voyager might not give this, will write 0
                    engagement: engagement,
                    isWinner: isWinner
                });

                if (isWinner) {
                    try {
                        await sheets.copyRowToTab('LinkedIn Posted', 'LinkedIn Winners', post.rowIndex);
                        console.log(`  -> 🏆 Winner moved to LinkedIn Winners`);
                    } catch (error) {
                        console.error(`  -> Failed to copy winner: ${error.message}`);
                    }
                }

                updatedCount++;
            } else {
                console.log('  -> No match found in recent feed.');
            }
        }

        console.log(`Voyager collection complete. Updated ${updatedCount} posts.`);

    } catch (error) {
        console.error('Voyager execution failed:', error.message);
        process.exit(1);
    }
}

main().catch(console.error);
