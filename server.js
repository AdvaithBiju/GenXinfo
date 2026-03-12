import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import dotenv from "dotenv";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 5050;
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID || "";
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET || "";
const REDDIT_USER_AGENT = process.env.REDDIT_USER_AGENT || "carxinfo-news-bot/1.0 by AdvaithBiju";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_OWNER = process.env.GITHUB_OWNER || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_FEED_PATH = process.env.GITHUB_FEED_PATH || "news/feed.json";

const DB_FILE = path.join(__dirname, "moderator-db.json");

const CATEGORY_MAP = {
  sports: ["sports", "nba", "formula1", "soccer", "cricket"],
  tech: ["technology", "gadgets", "artificial", "programming", "Futurology"],
  auto: ["cars", "Autos", "electricvehicles", "formula1", "TeslaLounge"],
  trending: ["news", "worldnews", "popular", "todayilearned", "videos"]
};

function ensureDb() {
  if (!fs.existsSync(DB_FILE)) {
    const seed = {
      candidates: [],
      published: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2), "utf8");
  }
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function writeDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf8");
}

function nowIso() {
  return new Date().toISOString();
}

function safeCategory(category) {
  const key = String(category || "").toLowerCase();
  if (!CATEGORY_MAP[key]) throw new Error("Invalid category");
  return key;
}

function normalizeImage(post) {
  if (post?.preview?.images?.[0]?.source?.url) {
    return post.preview.images[0].source.url.replace(/&amp;/g, "&");
  }
  if (post?.thumbnail && /^https?:\/\//.test(post.thumbnail)) {
    return post.thumbnail;
  }
  return "";
}

function hoursOld(createdUtc) {
  const createdMs = createdUtc * 1000;
  return Math.max(1, (Date.now() - createdMs) / (1000 * 60 * 60));
}

function scorePost(post) {
  const ups = Number(post.ups || 0);
  const comments = Number(post.num_comments || 0);
  const ratio = Number(post.upvote_ratio || 0);
  const ageHours = hoursOld(post.created_utc || 0);

  const freshnessBonus = Math.max(0, 72 - ageHours) * 1.2;
  const ratioScore = ratio * 100;

  return Number((ups * 0.5 + comments * 1.8 + ratioScore * 0.8 + freshnessBonus).toFixed(2));
}

function dedupeKey(post) {
  return `${post.subreddit}|${String(post.title || "").trim().toLowerCase()}`;
}

async function getRedditToken() {
  if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) {
    throw new Error("Missing Reddit credentials in .env");
  }

  const auth = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString("base64");

  const response = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "User-Agent": REDDIT_USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "client_credentials"
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Reddit token failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function fetchSubredditPosts(subreddit, token, limit = 10) {
  const url = `https://oauth.reddit.com/r/${subreddit}/top?t=day&limit=${limit}&raw_json=1`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": REDDIT_USER_AGENT
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Reddit fetch failed for r/${subreddit}: ${response.status} ${text}`);
  }

  const data = await response.json();
  return data?.data?.children?.map((item) => item.data) || [];
}

function filterPost(post) {
  if (!post) return false;
  if (post.over_18) return false;
  if (post.stickied) return false;
  if (post.removed_by_category) return false;
  if (!post.title) return false;
  if (Number(post.ups || 0) < 20) return false;
  return true;
}

async function collectCategory(category) {
  const token = await getRedditToken();
  const subreddits = CATEGORY_MAP[category];
  const db = readDb();

  const alreadySeen = new Set(db.candidates.map((c) => c.redditId));
  const seenTitles = new Set(db.candidates.map((c) => c.dedupeKey));
  const collected = [];

  for (const subreddit of subreddits) {
    const posts = await fetchSubredditPosts(subreddit, token, 10);

    for (const post of posts) {
      if (!filterPost(post)) continue;
      if (alreadySeen.has(post.id)) continue;

      const key = dedupeKey(post);
      if (seenTitles.has(key)) continue;

      const candidate = {
        id: `cand_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        redditId: post.id,
        dedupeKey: key,
        status: "pending",
        category,
        title: post.title,
        summary: "",
        subreddit: post.subreddit,
        author: post.author,
        ups: Number(post.ups || 0),
        num_comments: Number(post.num_comments || 0),
        upvote_ratio: Number(post.upvote_ratio || 0),
        score: scorePost(post),
        permalink: `https://www.reddit.com${post.permalink}`,
        url: post.url || `https://www.reddit.com${post.permalink}`,
        imageUrl: normalizeImage(post),
        createdUtc: post.created_utc,
        createdAt: new Date((post.created_utc || 0) * 1000).toISOString(),
        fetchedAt: nowIso(),
        approvedAt: null,
        rejectedAt: null,
        publishedAt: null,
        verified: false
      };

      collected.push(candidate);
      seenTitles.add(key);
      alreadySeen.add(post.id);
    }
  }

  collected.sort((a, b) => b.score - a.score);
  db.candidates.unshift(...collected);
  writeDb(db);

  return collected;
}

async function githubRequest(url, options = {}) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    throw new Error("Missing GitHub env values");
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API failed: ${response.status} ${text}`);
  }

  return response.json();
}

async function getGithubFile() {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FEED_PATH}?ref=${GITHUB_BRANCH}`;
  try {
    const data = await githubRequest(url, { method: "GET" });
    const content = Buffer.from(data.content, "base64").toString("utf8");
    return {
      exists: true,
      sha: data.sha,
      json: JSON.parse(content)
    };
  } catch (error) {
    if (String(error.message).includes("404")) {
      return { exists: false, sha: null, json: [] };
    }
    throw error;
  }
}

async function saveGithubFile(items) {
  const current = await getGithubFile();
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FEED_PATH}`;
  const payload = {
    message: `Update news feed: ${new Date().toISOString()}`,
    content: Buffer.from(JSON.stringify(items, null, 2), "utf8").toString("base64"),
    branch: GITHUB_BRANCH,
    committer: {
      name: "CarXInfo Bot",
      email: "bot@carxinfo.local"
    }
  };

  if (current.exists) payload.sha = current.sha;

  return githubRequest(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

function candidateToFeedItem(candidate, override = {}) {
  return {
    id: `news_${candidate.redditId}`,
    title: override.title || candidate.title,
    summary: override.summary || candidate.summary || `Trending post from r/${candidate.subreddit} with ${candidate.ups} upvotes and ${candidate.num_comments} comments.`,
    imageUrl: override.imageUrl || candidate.imageUrl || "",
    category: override.category || candidate.category,
    source: `Reddit / r/${candidate.subreddit}`,
    sourceUrl: candidate.permalink,
    publishedAt: new Date().toISOString(),
    verified: true
  };
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: nowIso() });
});

app.get("/api/categories", (req, res) => {
  res.json(Object.keys(CATEGORY_MAP));
});

app.post("/api/fetch/:category", async (req, res) => {
  try {
    const category = safeCategory(req.params.category);
    console.log("Fetching category:", category);

    const items = await collectCategory(category);

    console.log("Fetched items count:", items.length);
    res.json({ ok: true, fetched: items.length, items });
  } catch (error) {
    console.error("FETCH CATEGORY ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/candidates", (req, res) => {
  try {
    const db = readDb();
    const category = req.query.category ? safeCategory(req.query.category) : null;
    const status = req.query.status ? String(req.query.status) : null;

    let rows = db.candidates;
    if (category) rows = rows.filter((row) => row.category === category);
    if (status) rows = rows.filter((row) => row.status === status);

    rows = rows.sort((a, b) => b.score - a.score);
    res.json(rows);
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/reject/:id", (req, res) => {
  const db = readDb();
  const row = db.candidates.find((item) => item.id === req.params.id);

  if (!row) {
    return res.status(404).json({ ok: false, error: "Candidate not found" });
  }

  row.status = "rejected";
  row.rejectedAt = nowIso();
  writeDb(db);

  res.json({ ok: true, item: row });
});

app.post("/api/approve/:id", async (req, res) => {
  try {
    const { title, summary, category, imageUrl } = req.body || {};
    const db = readDb();
    const row = db.candidates.find((item) => item.id === req.params.id);

    if (!row) {
      return res.status(404).json({ ok: false, error: "Candidate not found" });
    }

    row.status = "approved";
    row.verified = true;
    row.approvedAt = nowIso();
    if (title) row.title = title;
    if (summary) row.summary = summary;
    if (imageUrl) row.imageUrl = imageUrl;
    if (category) row.category = safeCategory(category);

    const feedItem = candidateToFeedItem(row, { title, summary, category, imageUrl });
    const githubFile = await getGithubFile();
    const items = Array.isArray(githubFile.json) ? githubFile.json : [];

    const existingIndex = items.findIndex((item) => item.id === feedItem.id);
    if (existingIndex >= 0) items[existingIndex] = feedItem;
    else items.unshift(feedItem);

    await saveGithubFile(items);

    row.publishedAt = nowIso();
    db.published.unshift(feedItem);
    writeDb(db);

    res.json({ ok: true, item: row, feedItem });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/published", (req, res) => {
  const db = readDb();
  res.json(db.published);
});

app.get("/admin", (req, res) => {
  res.type("html").send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Reddit News Moderator</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; background: #111; color: #fff; }
    button, select, input, textarea { padding: 10px; margin: 6px 6px 6px 0; }
    .row { border: 1px solid #333; border-radius: 12px; padding: 16px; margin-bottom: 16px; background: #1b1b1b; }
    .meta { color: #aaa; font-size: 14px; }
    img { max-width: 280px; border-radius: 10px; display: block; margin-top: 10px; }
    textarea { width: 100%; min-height: 80px; }
    input { width: 100%; box-sizing: border-box; }
    a { color: #7cc5ff; }
  </style>
</head>
<body>
  <h1>Reddit News Moderator</h1>

  <div>
    <select id="category">
      <option value="sports">sports</option>
      <option value="tech">tech</option>
      <option value="auto">auto</option>
      <option value="trending">trending</option>
    </select>

    <button id="fetchBtn">Fetch Reddit</button>
    <button id="refreshBtn">Refresh Pending</button>
  </div>

  <p id="status">Ready</p>
  <div id="list"></div>

<script>
const statusEl = document.getElementById("status");
const listEl = document.getElementById("list");
const categoryEl = document.getElementById("category");
const fetchBtn = document.getElementById("fetchBtn");
const refreshBtn = document.getElementById("refreshBtn");

function setStatus(text) {
  statusEl.textContent = text;
}

fetchBtn.addEventListener("click", fetchCategory);
refreshBtn.addEventListener("click", loadCandidates);

async function fetchCategory() {
  const category = categoryEl.value;
  setStatus("Fetching from Reddit for " + category + "...");

  try {
    const res = await fetch("/api/fetch/" + category, { method: "POST" });
    const data = await res.json();

    console.log("FETCH RESULT:", data);

    if (!res.ok || !data.ok) {
      setStatus("Error: " + (data.error || "Unknown error"));
      return;
    }

    setStatus("Fetched " + data.fetched + " candidates");
    await loadCandidates();
  } catch (err) {
    console.error("FETCH ERROR:", err);
    setStatus("Browser error: " + err.message);
  }
}

async function loadCandidates() {
  const category = categoryEl.value;
  setStatus("Loading pending candidates for " + category + "...");

  try {
    const res = await fetch("/api/candidates?category=" + category + "&status=pending");
    const rows = await res.json();

    console.log("CANDIDATES:", rows);

    listEl.innerHTML = "";

    if (!Array.isArray(rows) || rows.length === 0) {
      listEl.innerHTML = "<p>No pending items in this category.</p>";
      setStatus("No pending items");
      return;
    }

    rows.forEach((row) => {
      const div = document.createElement("div");
      div.className = "row";

      const safeTitle = row.title || "";
      const safeImage = row.imageUrl || "";
      const safePermalink = row.permalink || "#";

      div.innerHTML = \`
        <h3>\${safeTitle}</h3>
        <div class="meta">r/\${row.subreddit} | ups: \${row.ups} | comments: \${row.num_comments} | score: \${row.score}</div>
        <p><a href="\${safePermalink}" target="_blank">Open Reddit post</a></p>
        \${safeImage ? '<img src="' + safeImage + '" />' : ""}
        <input id="title_\${row.id}" value="\${safeTitle.replace(/"/g, "&quot;")}" />
        <textarea id="summary_\${row.id}" placeholder="Write your verified summary here"></textarea>
        <button data-id="\${row.id}" class="approveBtn">Approve + Publish</button>
        <button data-id="\${row.id}" class="rejectBtn">Reject</button>
      \`;

      listEl.appendChild(div);
    });

    document.querySelectorAll(".approveBtn").forEach((btn) => {
      btn.addEventListener("click", () => approve(btn.dataset.id));
    });

    document.querySelectorAll(".rejectBtn").forEach((btn) => {
      btn.addEventListener("click", () => rejectItem(btn.dataset.id));
    });

    setStatus("Loaded " + rows.length + " pending items");
  } catch (err) {
    console.error("LOAD ERROR:", err);
    setStatus("Load error: " + err.message);
  }
}

async function approve(id) {
  const category = categoryEl.value;
  const title = document.getElementById("title_" + id).value;
  const summary = document.getElementById("summary_" + id).value;

  try {
    const res = await fetch("/api/approve/" + id, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, summary, category })
    });

    const data = await res.json();
    console.log("APPROVE RESULT:", data);

    if (!res.ok || !data.ok) {
      setStatus("Approve failed: " + (data.error || "Unknown error"));
      return;
    }

    setStatus("Approved and published");
    await loadCandidates();
  } catch (err) {
    console.error("APPROVE ERROR:", err);
    setStatus("Approve error: " + err.message);
  }
}

async function rejectItem(id) {
  try {
    const res = await fetch("/api/reject/" + id, { method: "POST" });
    const data = await res.json();

    console.log("REJECT RESULT:", data);

    if (!res.ok || !data.ok) {
      setStatus("Reject failed: " + (data.error || "Unknown error"));
      return;
    }

    setStatus("Rejected");
    await loadCandidates();
  } catch (err) {
    console.error("REJECT ERROR:", err);
    setStatus("Reject error: " + err.message);
  }
}

loadCandidates();
</script>
</body>
</html>
  `);
});

app.listen(PORT, () => {
  ensureDb();
  console.log(`Server running on http://localhost:${PORT}`);
});
