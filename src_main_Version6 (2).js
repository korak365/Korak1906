// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor } from 'apify';
// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { CheerioCrawler, Dataset, KeyValueStore } from 'crawlee';
import fetch from 'node-fetch';
import crypto from 'crypto';

// The init() call configures the Actor for its environment
await Actor.init();

// Structure of input is defined in input_schema.json
const {
    startUrls = [{ url: 'https://www.podcastone.com' }],
    maxEpisodesToScrape = 50,
    podcastCategories = ['Technology', 'Business'],
    includeTranscription = true,
    includeMetadata = true,
    extractTimestamps = true,
    extractSpeakers = true,
    extractKeyPhrases = true,
    extractQuotes = true,
    cleanTranscription = true,
    includeAudio = true,
    splitBySegments = true,
    minTranscriptionLength = 500,
    dateRange = 90,
    outputFormat = 'json',
} = (await Actor.getInput()) ?? {};

// Proxy configuration
const proxyConfiguration = await Actor.createProxyConfiguration();

// Statistics tracking
const statistics = {
    podcastsFound: 0,
    episodesScraped: 0,
    transcriptionsExtracted: 0,
    totalWords: 0,
    totalDuration: 0,
    speakersIdentified: 0,
    errors: 0,
    startTime: new Date(),
};

// Global data collections
const speakers = new Map();
const keyPhrases = new Map();
const allEpisodes = [];

// Helper function to clean transcription text
function cleanTranscriptionText(text) {
    if (!cleanTranscription) return text;

    // Remove common filler words
    const fillerWords = ['um', 'uh', 'like', 'you know', 'kind of', 'sort of', 'basically', 'essentially', '\\(laughs\\)', '\\[laughs\\]', '\\(pause\\)', '\\[pause\\]'];

    let cleaned = text;

    fillerWords.forEach((filler) => {
        const regex = new RegExp(`\\b${filler}\\b`, 'gi');
        cleaned = cleaned.replace(regex, '');
    });

    // Remove multiple spaces
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    // Fix common abbreviations
    cleaned = cleaned.replace(/don\'t/gi, 'do not').replace(/can\'t/gi, 'cannot').replace(/won\'t/gi, 'will not');

    return cleaned;
}

// Helper function to extract speakers from transcription
function extractSpeakersFromTranscription(text) {
    const speakerList = [];
    // Simple pattern: "Speaker Name: text"
    const speakerPattern = /^([A-Z][A-Za-z\s]+):\s+/gm;
    let match;

    while ((match = speakerPattern.exec(text)) !== null) {
        const name = match[1].trim();
        if (!speakerList.includes(name) && name.length > 2) {
            speakerList.push(name);
        }
    }

    return speakerList;
}

// Helper function to extract key phrases
function extractKeyPhrasesFromText(text) {
    const phrases = new Map();

    // Extract noun phrases (simple heuristic)
    const nounPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
    let match;

    while ((match = nounPattern.exec(text)) !== null) {
        const phrase = match[1];
        if (phrase.length > 3) {
            phrases.set(phrase, (phrases.get(phrase) || 0) + 1);
        }
    }

    // Extract multi-word phrases
    const multiWordPattern = /\b([a-z]+\s+[a-z]+\s+[a-z]+)\b/gi;
    while ((match = multiWordPattern.exec(text)) !== null) {
        const phrase = match[1];
        phrases.set(phrase, (phrases.get(phrase) || 0) + 1);
    }

    return phrases;
}

// Helper function to extract quotes
function extractQuotes(text) {
    const quotes = [];

    // Find quoted text
    const quotedPattern = /["']([^"']{20,200})['"]/g;
    let match;

    while ((match = quotedPattern.exec(text)) !== null) {
        quotes.push(match[1].trim());
    }

    // Find sentences that might be memorable
    const sentences = text.match(/[^.!?]*[.!?]+/g) || [];
    const memorablePatterns = /(?:believe|think|important|key|essential|critical|must|never|always)/i;

    sentences.forEach((sentence) => {
        if (memorablePatterns.test(sentence) && sentence.length > 30 && sentence.length < 200) {
            quotes.push(sentence.trim());
        }
    });

    return quotes.slice(0, 5); // Return top 5
}

// Helper function to parse timestamp format
function parseTimestamp(timeStr) {
    // Format: HH:MM:SS or MM:SS
    const parts = timeStr.split(':').map((p) => parseInt(p));
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    }
    return 0;
}

// Helper function to split transcription into segments
function splitIntoSegments(transcription) {
    const segments = [];
    const lines = transcription.split('\n');
    let currentSegment = {
        startTime: '00:00:00',
        speakers: [],
        content: '',
    };

    lines.forEach((line) => {
        // Check for timestamp
        const timestampPattern = /^\[?(\d{1,2}:\d{2}:\d{2})\]?\s*-?\s*(.+)/;
        const match = line.match(timestampPattern);

        if (match) {
            if (currentSegment.content.length > 0) {
                segments.push(currentSegment);
            }
            currentSegment = {
                startTime: match[1],
                speakers: [],
                content: match[2],
            };
        } else {
            currentSegment.content += '\n' + line;
        }
    });

    if (currentSegment.content.length > 0) {
        segments.push(currentSegment);
    }

    return segments;
}

// Helper function to extract episode metadata
function extractEpisodeMetadata($, url) {
    const metadata = {
        episodeUrl: url,
        podcastName: $('meta[property="og:site_name"]').attr('content') || $('title').text().split('|')[0].trim(),
        episodeTitle: $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim(),
        description: $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '',
        publishDate: $('meta[property="article:published_time"]').attr('content') || $('time').first().attr('datetime') || new Date().toISOString(),
        duration: $('[class*="duration"]').text() || $('span:contains("Duration")').next().text() || 'Unknown',
        category: $('[class*="category"], [class*="genre"]').text() || 'General',
        audioUrl: $('audio').attr('src') || $('source[type*="audio"]').attr('src') || '',
        imageUrl: $('meta[property="og:image"]').attr('content') || '',
        hosts: [],
        guests: [],
    };

    // Extract hosts and guests
    const hostElements = $('[class*="host"], [class*="presenter"]');
    hostElements.each((i, el) => {
        const name = $(el).text().trim();
        if (name) metadata.hosts.push(name);
    });

    const guestElements = $('[class*="guest"], [class*="speaker"]');
    guestElements.each((i, el) => {
        const name = $(el).text().trim();
        if (name) metadata.guests.push(name);
    });

    return metadata;
}

// Helper function to extract transcription from page
function extractTranscription($) {
    let transcription = '';

    // Look for common transcription containers
    const transcriptionSelectors = [
        '.transcript',
        '.transcription',
        '[class*="transcript"]',
        '[class*="transcription"]',
        '.episode-transcript',
        '.full-transcript',
        '[data-content="transcript"]',
    ];

    for (const selector of transcriptionSelectors) {
        const element = $(selector).first();
        if (element.length) {
            transcription = element.text();
            break;
        }
    }

    // Fallback: try to find transcript in common structures
    if (!transcription) {
        const mainContent = $('main, article, [role="main"]').first();
        if (mainContent.length) {
            // Get all paragraph text
            let text = '';
            mainContent.find('p').each((i, el) => {
                text += $(el).text() + '\n';
            });
            transcription = text;
        }
    }

    return transcription;
}

// Helper function to count words
function countWords(text) {
    return text.split(/\s+/).filter((w) => w.length > 0).length;
}

// Helper function to parse duration to seconds
function parseDuration(durationStr) {
    const match = durationStr.match(/(\d+):(\d{2}):(\d{2})/);
    if (match) {
        return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]);
    }
    return 0;
}

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: maxEpisodesToScrape,
    async requestHandler({ request, $, log }) {
        const url = request.loadedUrl;
        log.info(`Processing: ${url}`);

        try {
            // Extract metadata
            const metadata = extractEpisodeMetadata($, url);

            // Check if episode is within date range
            if (dateRange > 0) {
                const publishDate = new Date(metadata.publishDate);
                const daysAgo = (Date.now() - publishDate.getTime()) / (1000 * 60 * 60 * 24);
                if (daysAgo > dateRange) {
                    log.debug(`Skipping episode from ${daysAgo.toFixed(0)} days ago`);
                    return;
                }
            }

            // Extract transcription
            let transcription = extractTranscription($);

            if (!transcription || countWords(transcription) < minTranscriptionLength) {
                log.warning(`Transcription too short or missing for: ${metadata.episodeTitle}`);
                return;
            }

            // Clean transcription
            if (cleanTranscription) {
                transcription = cleanTranscriptionText(transcription);
            }

            const wordCount = countWords(transcription);
            const episodeId = crypto.createHash('md5').update(url + metadata.episodeTitle).digest('hex').slice(0, 12);

            // Initialize episode data
            const episodeData = {
                episodeId,
                ...metadata,
                wordCount,
                transcription,
                speakers: [],
                quotes: [],
                keyPhrases: {},
                segments: [],
            };

            // Extract speakers
            if (extractSpeakers) {
                const identifiedSpeakers = extractSpeakersFromTranscription(transcription);
                episodeData.speakers = identifiedSpeakers;

                // Update global speakers map
                identifiedSpeakers.forEach((speaker) => {
                    if (!speakers.has(speaker)) {
                        speakers.set(speaker, {
                            name: speaker,
                            episodes: [],
                            appearances: 0,
                        });
                    }
                    const speakerData = speakers.get(speaker);
                    if (!speakerData.episodes.includes(episodeId)) {
                        speakerData.episodes.push(episodeId);
                    }
                    speakerData.appearances += 1;
                });
            }

            // Extract key phrases
            if (extractKeyPhrases) {
                const phrases = extractKeyPhrasesFromText(transcription);
                episodeData.keyPhrases = Object.fromEntries(phrases);

                // Update global key phrases
                phrases.forEach((count, phrase) => {
                    if (!keyPhrases.has(phrase)) {
                        keyPhrases.set(phrase, {
                            frequency: 0,
                            episodes: [],
                        });
                    }
                    const phraseData = keyPhrases.get(phrase);
                    phraseData.frequency += count;
                    if (!phraseData.episodes.includes(episodeId)) {
                        phraseData.episodes.push(episodeId);
                    }
                });
            }

            // Extract quotes
            if (extractQuotes) {
                episodeData.quotes = extractQuotes(transcription);
            }

            // Split into segments
            if (splitBySegments && extractTimestamps) {
                episodeData.segments = splitIntoSegments(transcription);
            }

            // Save to dataset
            await Dataset.pushData({
                episodeId,
                podcastName: metadata.podcastName,
                episodeTitle: metadata.episodeTitle,
                publishDate: metadata.publishDate,
                duration: metadata.duration,
                wordCount,
                speakers: episodeData.speakers.join(', '),
                category: metadata.category,
                url: metadata.episodeUrl,
            });

            // Save speakers to dataset
            if (extractSpeakers) {
                episodeData.speakers.forEach((speaker) => {
                    Dataset.pushData({
                        type: 'speaker',
                        speakerId: crypto.createHash('md5').update(speaker).digest('hex').slice(0, 8),
                        speakerName: speaker,
                        episodeId,
                        episodeTitle: metadata.episodeTitle,
                    });
                });
            }

            // Save key phrases to dataset
            if (extractKeyPhrases) {
                Object.entries(episodeData.keyPhrases)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 10)
                    .forEach(([phrase, count]) => {
                        Dataset.pushData({
                            type: 'phrase',
                            phrase,
                            frequency: count,
                            episodes: 1,
                            context: `From: ${metadata.episodeTitle}`,
                        });
                    });
            }

            // Store full episode data
            allEpisodes.push(episodeData);

            statistics.episodesScraped++;
            statistics.transcriptionsExtracted++;
            statistics.totalWords += wordCount;
            statistics.speakersIdentified += episodeData.speakers.length;

            log.info(
                `Saved episode: ${metadata.episodeTitle} (${wordCount} words, ${episodeData.speakers.length} speakers)`
            );
        } catch (error) {
            log.error(`Error processing episode: ${error.message}`);
            statistics.errors++;
        }

        // Enqueue links to other episodes
        const episodeLinks = $('a[href*="/episode"], a[href*="/ep-"], [class*="episode-link"]')
            .slice(0, 10)
            .map((i, el) => $(el).attr('href'))
            .get()
            .filter((href) => href && href.startsWith('http'));

        if (episodeLinks.length > 0) {
            await crawler.addRequests(episodeLinks.map((url) => ({ url })));
        }
    },

    errorHandler({ request, error, log }) {
        log.error(`Request failed: ${request.url}`, error);
        statistics.errors++;
    },
});

// Run the crawler
try {
    await crawler.run(startUrls);
} catch (error) {
    console.error('Crawler error:', error);
    statistics.errors++;
}

// Compile final speakers data
const speakersArray = Array.from(speakers.values()).map((speaker) => ({
    speakerId: crypto.createHash('md5').update(speaker.name).digest('hex').slice(0, 8),
    speakerName: speaker.name,
    title: 'Podcast Contributor',
    company: 'Unknown',
    episodesCount: speaker.episodes.length,
    totalAppearances: speaker.appearances,
}));

// Compile final key phrases data
const phrasesArray = Array.from(keyPhrases.values())
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 100)
    .map((phrase, idx) => ({
        id: idx,
        phrase: phrase.phrase || Object.keys(phrase)[0],
        frequency: phrase.frequency,
        episodes: phrase.episodes.length,
        context: `Mentioned across ${phrase.episodes.length} episodes`,
    }));

// Save to dataset
for (const speaker of speakersArray) {
    await Dataset.pushData({
        type: 'speaker_summary',
        ...speaker,
    });
}

for (const phrase of phrasesArray) {
    await Dataset.pushData({
        type: 'phrase_summary',
        ...phrase,
    });
}

// Save statistics and export to Key-Value Store
const kvStore = await KeyValueStore.open();

const datasetStatistics = {
    reportDate: new Date().toISOString(),
    summary: {
        episodesScraped: statistics.episodesScraped,
        totalWords: statistics.totalWords,
        totalDuration: statistics.totalDuration,
        speakersIdentified: speakers.size,
        keyPhrasesIdentified: keyPhrases.size,
        averageWordsPerEpisode:
            statistics.episodesScraped > 0 ? (statistics.totalWords / statistics.episodesScraped).toFixed(0) : 0,
    },
    topSpeakers: speakersArray.sort((a, b) => b.totalAppearances - a.totalAppearances).slice(0, 10),
    topPhrases: phrasesArray.slice(0, 20),
    errors: statistics.errors,
    duration: new Date() - statistics.startTime,
};

await kvStore.setValue('DATASET_STATISTICS', JSON.stringify(datasetStatistics, null, 2));

// Export all transcriptions
if (outputFormat === 'json') {
    const exportData = {
        exportDate: new Date().toISOString(),
        statistics: datasetStatistics,
        episodes: allEpisodes,
    };
    await kvStore.setValue('TRANSCRIPTIONS_EXPORT', JSON.stringify(exportData, null, 2));
} else if (outputFormat === 'markdown') {
    let mdContent = '# Podcast Transcriptions Dataset\n\n';
    mdContent += `Generated: ${new Date().toISOString()}\n\n`;

    allEpisodes.forEach((ep, idx) => {
        mdContent += `## ${idx + 1}. ${ep.episodeTitle}\n\n`;
        mdContent += `**Podcast:** ${ep.podcastName}\n`;
        mdContent += `**Date:** ${ep.publishDate}\n`;
        mdContent += `**Duration:** ${ep.duration}\n`;
        mdContent += `**Words:** ${ep.wordCount}\n\n`;

        if (ep.speakers.length > 0) {
            mdContent += `**Speakers:** ${ep.speakers.join(', ')}\n\n`;
        }

        mdContent += `### Transcription\n\n${ep.transcription}\n\n`;

        if (ep.quotes.length > 0) {
            mdContent += `### Notable Quotes\n\n${ep.quotes.map((q) => `> ${q}`).join('\n\n')}\n\n`;
        }

        mdContent += '---\n\n';
    });

    await kvStore.setValue('TRANSCRIPTIONS_EXPORT', mdContent);
}

console.log('\n=== Podcast Transcription Scraping Complete ===');
console.log(`Episodes scraped: ${statistics.episodesScraped}`);
console.log(`Total words: ${statistics.totalWords}`);
console.log(`Unique speakers: ${speakers.size}`);
console.log(`Key phrases identified: ${keyPhrases.size}`);
console.log(`Average words per episode: ${(statistics.totalWords / (statistics.episodesScraped || 1)).toFixed(0)}`);
console.log(`Errors: ${statistics.errors}`);

// Gracefully exit the Actor process
await Actor.exit();