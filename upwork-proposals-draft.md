# Upwork Proposal Drafts — 2026-03-07

---

## 1. AI Automation Integrator - Real Estate Operation ($1,200 fixed)

### Cover Letter

Hi,

Real estate transaction automation across FUB, SkySlope, OneDrive, Sage, and Teams — this is a systems integration job, not a "set up a Zapier" job. That distinction matters and it's clear from how you wrote this posting that you already know that.

I run an AI orchestration platform on a Mac Mini that manages 28+ projects autonomously — it routes SMS commands to specialized agents, manages child processes, handles escalation logic, and logs everything. The architecture is the same pattern you need: trigger event → validate → route to the right system → confirm → notify. The difference is your triggers are deal milestones and your output surfaces are OneDrive folders, SkySlope files, Sage entries, and Teams channels.

Relevant work:
- **Autonomous AI Orchestrator** — Production system with Claude AI managing workflows, child sessions, health monitoring, and human-in-the-loop escalation. Runs 24/7 and has for months. (https://brad.mccloskey-api.com/case-studies/autonomous-agent-orchestration)
- **Multi-system API Integrations** — Built production data pipelines connecting APIs with structured field mapping, deduplication, and error handling. Same patterns needed for FUB → Tracker → SkySlope → Sage flows.
- **Excel/Data Automation** — Built and maintained complex workbooks with formula dependencies. I understand why you don't touch a 1,500-formula tracker without testing first.

**Portfolio:** https://brad.mccloskey-api.com
**GitHub:** https://github.com/bradmccloskey

Brad

### Screening Answers

**1. Tool Experience:**

I've built production automations with Zapier, n8n, Claude AI (both projects and API), and Microsoft 365 (OneDrive, Teams, Excel). I don't have direct real estate transaction management experience, but I've built systems with the same complexity pattern — multi-step workflows where data integrity matters and downtime costs money.

My strongest example: I built an autonomous AI orchestrator that has been running in production for months. It receives inbound messages, classifies intent, routes to specialized agents, manages state across 28+ projects, and escalates to a human when confidence is low. It connects to iMessage, tmux sessions, SQLite databases, health monitors, and launchd services — all coordinated through a single brain. That system processes real transactions (Upwork proposals, trading bot signals, service health alerts) and nothing goes live without passing validation. That's the same discipline your tracker environment needs.

**2. Design Question:**

FUB to OneDrive folder creation:
First, I'd map the exact trigger — which FUB deal stage fires the automation. Then I'd build a Zapier/n8n workflow that: (1) triggers on the FUB deal stage change, (2) extracts the fields needed for folder naming (property address, deal ID, agent name), (3) calls the Microsoft Graph API to create the folder structure in OneDrive under the correct parent directory, (4) writes the folder URL back to the FUB deal record or tracker, and (5) sends a Teams notification confirming creation. Before touching live systems, I'd build this against a test OneDrive directory and a test FUB pipeline, run it through 10+ synthetic deals, and document the field mapping.

Sage 50 handoff for two entities:
The key decision point is which entity the deal belongs to — Lapp Realty or KLRT Commercial. I'd design a routing step that reads the entity field from the tracker row and branches accordingly. Sage 50's API support is limited (depends on the version — Sage 50 CA vs US, desktop vs cloud), so the cleanest path is likely a formatted output: a structured CSV or spreadsheet row that lands in a shared location the bookkeeper pulls from, with all fields pre-mapped to Sage's chart of accounts. If the Sage version supports direct API (Sage Business Cloud), I'd build a direct integration. Either way, the automation produces the data — the bookkeeper confirms before import. No auto-posting to accounting without human approval.

**3. 90-Day Plan:**

Days 1-10: Audit. I'd inventory every existing Zapier zap, document which ones are connected vs broken, map the current tracker field structure against FUB fields, and catalog the Claude AI projects. I'd get access to SkySlope API docs and the Sage 50 version. Deliverable: a status document showing what works, what's broken, and what's missing.

Days 11-30: Reconnect and rebuild priority automations. Fix broken FUB → tracker zaps first since those are the foundation. Build the OneDrive folder creation automation. Get the deadline alert system running (7/3/1/day-of). All tested against a staging environment before touching production.

Days 31-60: SkySlope API integration once credentials are secured. Teams notification routing. YourAtlas → FUB data flow to prevent duplicate leads. Each automation designed, documented, tested, then deployed.

Days 61-90: Sage 50 accounting handoff. Knowledge base cleanup. Documentation for every automation in production. Handoff document so the team can troubleshoot without me.

Throughout: nothing touches the live tracker without a passing test. Blockers communicated same-day. Every automation documented before it's considered done.

---

## 2. Claude AI Expert - Web Design Automation ($15-40/hr)

### Cover Letter

Hi,

I use Claude daily for exactly this kind of work — code generation, design iteration, and building production tools faster.

I run a 24/7 AI orchestrator powered by Claude that manages 28+ software projects, generates code, handles API integrations, and automates workflows. I've built deep expertise in getting Claude to produce clean, production-ready output — not just "generate some code and hope" but structured prompting that produces reliable GSAP animations, component code, and design systems.

For your specific needs:

- **GSAP animations** — Claude is excellent at generating GSAP ScrollTrigger, timeline, and stagger animations. The key is giving it your existing markup structure and being specific about easing, duration, and trigger points. I can show you prompt patterns that produce copy-paste-ready GSAP code.
- **Bricks Builder blocks** — I can help you set up Claude projects with your Bricks element structure as context, so it generates blocks that match your existing design system instead of generic WordPress output.
- **Design inspiration** — Claude with vision can analyze reference sites and break down the CSS/animation techniques used. Combined with web search, it becomes a research assistant that explains *how* a design effect works, not just what it looks like.

I'm happy to log hours answering questions and doing screen-share sessions where I show you the workflows I use. The goal would be to get you self-sufficient with Claude, not create a dependency on me.

**Portfolio:** https://brad.mccloskey-api.com
**GitHub:** https://github.com/bradmccloskey

Brad

---

## 3. AI Content Pipeline - Zapier/Make + OpenAI + WordPress + Monday.com ($10-35/hr)

### Cover Letter

Synthesis. I've built multi-app integration pipelines that follow the same pattern you need: trigger → AI processing → structured output → multiple downstream systems.

My most relevant build is an AI orchestrator that receives inbound messages, processes them through Claude's API with structured prompts, and routes outputs to the correct downstream system — SQLite databases, child processes, notification channels, and external APIs. It runs 24/7 in production and handles real transactions. The architecture maps directly to your flow: Slack trigger → AI content generation → WordPress draft → Monday.com tracker → email notification.

Specific experience with your stack:
- **AI API integration** — I work with Claude and OpenAI APIs daily, including structured output formatting, prompt engineering for consistent tone/voice, and error handling when the API returns garbage
- **WordPress REST API** — I've built content publishing pipelines that push formatted posts with proper headers, categories, and metadata
- **Webhook/API orchestration** — Built production systems that chain API calls with conditional logic, retry handling, and logging

For your workflow, the critical piece is the AI prompt engineering — getting GPT-4o/Gemini to consistently produce articles in your brand voice with proper SEO metadata. I'd want to see 3-5 examples of your published content to build a style guide into the system prompt before wiring up any automations. The Zapier/Make wiring is straightforward; the AI output quality is where this project succeeds or fails.

I'd also build in a simple feedback loop: when an editor marks significant changes to an AI draft in WordPress, that feedback gets logged so we can iteratively improve the prompt.

**Portfolio:** https://brad.mccloskey-api.com
**GitHub:** https://github.com/bradmccloskey

Brad

---

## 4. AI Automation Consultant - Social, Ads, Video, Ops ($30+/hr, 6+ months)

### Cover Letter

Hi,

Building AI automation with guardrails — not just "connect ChatGPT to everything" — is the hard part of this work. The fact that you mentioned approval flows, logging, and documentation tells me you've either been burned by bad automation or you're smart enough to prevent it. Either way, we're aligned.

Relevant examples:

1. **AI Orchestrator with human-in-the-loop** — I built a production system where Claude manages 28+ projects autonomously but escalates to a human when confidence is low. It has configurable guardrails, audit logging, and documentation that updates itself. The escalation logic — knowing when AI output needs human approval before going live — is the same pattern you need for social posts and ad creative.

2. **Content generation pipelines** — Built automated workflows that take structured input, run it through AI with brand-specific system prompts, and produce formatted output. The key is constraining the AI's creativity to stay on-brand — I use structured output schemas, few-shot examples, and validation steps.

3. **Monitoring and alerting** — My production systems include automated health checks, performance tracking, and threshold-based alerts. Same infrastructure needed for KPI spike detection and pacing alerts on ad campaigns.

Suggested stack for your needs:
- **Claude API** for content generation (better at following brand guidelines than GPT in my experience)
- **Make.com** for workflow orchestration (more flexible than Zapier for complex conditional logic)
- **Airtable or Notion** as the approval/logging layer
- **Platform APIs** (Meta, LinkedIn, X) for posting with draft/review stages

How I enforce brand rules: every workflow has a system prompt with explicit brand voice guidelines, prohibited terms, required disclaimers, and formatting rules. Output goes through a validation step before any external action. Nothing posts without passing the guardrails.

**Portfolio:** https://brad.mccloskey-api.com
**GitHub:** https://github.com/bradmccloskey

Brad

---

## 5. Hotel Operations Automation - Make.com/n8n ($20-55/hr)

### Cover Letter

Hi,

The five workflows you described — reservation → CRM, pre-arrival comms, housekeeping task creation, review requests, and ops dashboard — are all variations of the same pattern: event trigger → data extraction → conditional routing → action + notification. I've built production systems with this exact architecture.

My most relevant work is an autonomous orchestrator that manages 28+ projects with event-driven workflows: inbound triggers fire automated actions, state gets tracked in databases, notifications go to the right channels, and everything logs for audit. It runs 24/7 on a Mac Mini and manages real operations — service health monitoring, trading signals, content generation, and human escalation. Same bones as hotel ops automation, different skin.

Specific experience:
- **n8n workflows** — I prefer n8n over Make.com for complex multi-step automations because of self-hosting flexibility and better error handling. Built production workflows with webhook triggers, API integrations, conditional branching, and database operations.
- **API integrations** — Connected dozens of external APIs with proper auth handling, rate limiting, retry logic, and data mapping. PMS/booking platform APIs follow standard REST patterns.
- **Automated notifications** — Built email and messaging pipelines with templating, personalization, and scheduling logic.
- **Dashboards** — Built real-time operational dashboards that aggregate data from multiple sources and update automatically.

For the hotel workflows, I'd start with #1 (reservation → CRM) since it's the foundation that the other four depend on. Get the guest record creation solid, then layer on pre-arrival comms and post-checkout flows. The dashboard comes last since it aggregates data from all the other workflows.

Happy to walk through a more detailed approach for any of the five workflows.

**Portfolio:** https://brad.mccloskey-api.com
**GitHub:** https://github.com/bradmccloskey

Brad

---

## 6. Senior Data Automation Engineer - Government Records Monitoring ($25-40/hr)

### Cover Letter

Hi,

NC county government portal scraping with Playwright — this is directly in my wheelhouse. I'm based in North Carolina and I've built production scraping infrastructure that runs daily against sites with anti-bot measures, dynamic content, and inconsistent HTML structures.

My scraping stack:
- **Playwright** for browser automation — stealth configuration, session persistence, proxy rotation, and challenge handling
- **Production pipelines** deployed on RapidAPI and Apify that handle Google Maps, Amazon, and job boards at scale with retry logic, proxy failover, and alerting when success rates drop
- **PostgreSQL/SQLite** for structured storage with deduplication logic
- **Scheduled execution** via launchd/cron with health monitoring

For this project specifically:

I know the NC court system uses eCourts (Odyssey-based) for many counties, which means one well-built Playwright module can handle multiple counties with just parameter changes (county code, date range, record type). I'd start by categorizing the ~20 portals into clusters by platform — eCourts counties, Register of Deeds (typically Avenu/GovTech), and any county-specific portals. Each cluster gets one reusable scraper module.

The pipeline architecture I'd build:
1. **Scheduler** — daily cron trigger per portal, staggered to avoid hammering
2. **Scraper modules** — Playwright scripts per portal cluster, extracting county, record type, filing date, case/instrument number, party name, property address, document link
3. **Parser/normalizer** — standardize field formats across different portal output structures
4. **Database** — PostgreSQL with composite unique keys for deduplication (county + case number + filing date)
5. **Monitor** — alerting on scraper failures, zero-result days, and schema changes

Largest scraping system I've deployed: a multi-source data pipeline that scrapes and normalizes data from 10+ sources daily, handles pagination, JavaScript rendering, rate limiting, and stores ~50K+ records with dedup. Runs autonomously with health monitoring and auto-recovery.

**Portfolio:** https://brad.mccloskey-api.com
**GitHub:** https://github.com/bradmccloskey

Brad

### Screening Answers

**1. Playwright automation projects:**
Built production Playwright scrapers deployed on Apify and RapidAPI that handle anti-bot detection (Cloudflare challenges, fingerprint randomization, CDP-level interception). These run daily against Google Maps, Amazon, and job boards with stealth configuration, proxy rotation, and session management. Also built a browser automation system using Playwright CLI for dashboard monitoring and data extraction across authenticated web portals.

**2. Largest scraping system deployed:**
A multi-source data pipeline that scrapes 10+ websites daily, handles JavaScript-rendered content, pagination, rate limiting, and proxy failover. Stores ~50K+ records in SQLite/PostgreSQL with composite-key deduplication. Includes health monitoring, failure alerting, and auto-recovery. Runs on scheduled cron jobs with staggered execution to manage load. The system has been in continuous production for months.

**3. Preferred tech stack:**
Playwright (Node.js) for browser automation, Python for data processing/normalization, PostgreSQL for structured storage with deduplication indices, node-cron or launchd for scheduling, and a simple monitoring layer that alerts on failures via SMS/email. For NC government portals specifically, I'd use Playwright over HTTP-based scrapers because most county systems use JavaScript-rendered content and session-based navigation.

---

*END OF PROPOSALS*
