# BBX Server OS - AI Orchestration Platform

**Repository:** https://github.com/dpkchohan/bbx-server-os  
**Project:** NASA GSFC AI Infrastructure  
**Status:** 🚧 Development

---

## 📋 Project Overview

Self-hosted job orchestration for AI workloads:
- Meeting transcription (multi-language)
- Document analysis
- Long-running AI agent tasks
- Semantic search across all data

---

## 🏗️ Architecture Decisions

### [DATE] - Initial Architecture
- **Chosen:** [TBD - Trigger.dev v3 vs Inngest]
- **Reason:** [To be filled by Cline]
- **Alternatives considered:** [List]

### [DATE] - Infrastructure Sizing
- **EC2:** t3.large (8GB RAM, 64GB SSD)
- **Reason:** Cost optimization, sufficient for 100-500 meetings/month
- **Rejected:** t3.2xlarge (overkill)

---

## 🛠️ Tech Stack

**Orchestration:** TBD  
**Database:** PostgreSQL 15  
**Queue:** Redis 7  
**Vector DB:** Qdrant  
**Cloud:** AWS (us-east-1)

---

## 📁 Project Structure
