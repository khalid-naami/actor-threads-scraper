# 🧵 Threads (Meta) Ultimate Scraper (Profiles, Posts, Replies, Likes & Search)

High-speed, all-in-one Threads by Meta (`threads.net`) data extraction and sentiment intelligence engine on Apify. Extract **Creator Profiles & Leads** (bio, follower counts, verified blue badges, emails/phones), **Posts & Microblogs** (text, like counts, reply counts, reposts), **Media Attachments** (HD images, direct MP4 videos), and **Keyword Search** without requiring a login or account.

---

## ⚡ Key Features

- 👤 **Creator Profile Intelligence**: Extract Full Name, Handle (`@username`), Bio, Follower Counts, Blue Verified Badge, Profile Pictures, and external bio links.
- 💬 **Posts & Microblogs Extraction**: Scrape thread posts with full text, publication timestamp, like count, reply count, repost count, and shortcodes.
- 🎬 **Media Attachments (Images & MP4 Videos)**: High-resolution photos, carousels, and direct MP4 video streaming links.
- 🔍 **Keyword & Hashtag Search**: Search across Threads for any topic or hashtag to discover trending discussions and monitor brand sentiment.
- 📧 **Direct Lead Generation**: Automatically extracts business contact emails and phone numbers found in creator bios and thread text.
- 🌐 **Zero Login Required**: Operates completely without needing an Instagram or Threads account, session token, or login credentials.
- 🛡️ **Dual-Engine Speed & Reliability**: Fast HTTP requests via `got-scraping` paired with an intelligent Playwright browser fallback.

---

## 📥 Input Configuration

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `mode` | String | `AUTO_DETECT` | Extraction mode: `AUTO_DETECT`, `PROFILES`, `POSTS`, `SEARCH`. |
| `targetUrls` | Array | `[...]` | List of Threads URLs (`threads.net/@username` or `threads.net/@username/post/...`). |
| `searchKeywords` | Array | `[]` | Keywords or hashtags to search across Threads. |
| `maxPosts` | Integer | `30` | Maximum posts to extract per creator or search query. |
| `maxReplies` | Integer | `20` | Maximum replies to extract per post. |
| `proxyConfiguration` | Object | `{ useApifyProxy: true }` | Apify Residential proxy configuration (recommended). |

---

## 📤 Output Data Format

### 1. Threads Creator Profile Record

```json
{
  "type": "PROFILE",
  "id": "zuck",
  "username": "@zuck",
  "displayName": "Mark Zuckerberg",
  "url": "https://www.threads.net/@zuck",
  "bio": "Building the future of human connection. Contact: team@meta.com",
  "followersCount": "6.8M",
  "followersCountRaw": 6800000,
  "isVerified": true,
  "profilePictureUrl": "https://scontent.cdninstagram.com/...",
  "externalLink": "https://about.meta.com",
  "email": "team@meta.com",
  "emails": [
    "team@meta.com"
  ],
  "scrapedAt": "2026-10-09T23:25:00.000Z"
}
```

### 2. Threads Post Record with Media & Metrics

```json
{
  "type": "POST",
  "id": "C9x123abc456",
  "postCode": "C9x123abc456",
  "url": "https://www.threads.net/@zuck/post/C9x123abc456",
  "username": "@zuck",
  "text": "Llama 3.3 is rolling out today. Open-source AI continues to accelerate.",
  "likesCount": 42000,
  "replyCount": 3800,
  "repostCount": 2100,
  "mediaType": "image",
  "imageUrls": [
    "https://scontent.cdninstagram.com/..."
  ],
  "publishedAt": "2026-10-08T16:00:00.000Z",
  "scrapedAt": "2026-10-09T23:25:00.000Z"
}
```

---

## 💼 Business & Creator Use Cases

- **Real-Time Social Listening & PR**: Track what industry influencers and journalists are posting on Threads.
- **Competitor Tracking**: Compare follower growth, posting frequency, and engagement metrics against competitors.
- **Influencer Sourcing**: Build targeted lists of creators on Threads with direct contact emails.

---

## 📄 License
Apache-2.0
