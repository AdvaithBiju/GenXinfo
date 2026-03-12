# GenXinfo

This repository contains the external backend and publishing workflow that accesses Reddit's API in a read-only manner, queues posts for manual review, and publishes approved items to my app feed.

## What it does
- Fetches public Reddit posts from selected categories such as tech, sports, auto, and trending
- Ranks posts using engagement signals such as score, comments, and recency
- Sends posts to a private moderation dashboard for manual approval or rejection
- Publishes only approved items into a structured JSON feed for my external mobile app

## Important notes
- Read-only Reddit usage
- No posting, commenting, voting, messaging, or moderation actions on Reddit
- Preserves attribution and links back to the original Reddit thread
