// Fakes for category/competitor tests: an LLM that answers from a handler (output still goes
// through the real zod validation), a search provider backed by a table, and website facts.
import { vi } from "vitest";
import { parseStructured, type LlmProvider, type StructuredRequest } from "../src/services/llm.service.js";
import type { SearchProvider, SearchResult } from "../src/services/search.service.js";
import type { WebsiteHeading, WebsiteResearch } from "../src/types/website.js";
import type { CategoryResult } from "../src/types/discovery.js";
import type { z } from "zod";

export function fakeLlm(handler: (req: StructuredRequest<z.ZodType>) => unknown) {
  const calls: StructuredRequest<z.ZodType>[] = [];
  const provider: LlmProvider = {
    name: "fake",
    model: "fake-model",
    async generateObject(req) {
      calls.push(req);
      const out = await handler(req);
      // Raw strings let tests simulate non-JSON output.
      return parseStructured(req.schema, typeof out === "string" ? out : JSON.stringify(out));
    },
  };
  return Object.assign(provider, { calls });
}

export function fakeSearch(answer: (query: string) => SearchResult[] | Promise<SearchResult[]>) {
  const search = vi.fn(async (query: string) => answer(query));
  const provider: SearchProvider = { name: "fake-search", search };
  return Object.assign(provider, { search });
}

export const result = (url: string, title: string, snippet = "", score = 0.5): SearchResult => ({ url, title, snippet, score });

const TEXT =
  "Acme Content is a B2B technical content marketing agency for software companies. We write developer documentation, " +
  "technical blog posts and product marketing content that is accurate and built to convert. Our team of engineers and " +
  "writers plans your content strategy, produces every article and publishes it end to end. We also help B2B tech brands " +
  "get cited in AI search answers. Clients include SaaS startups, developer tool vendors and cloud platforms that need " +
  "content their technical buyers trust. Book a call to plan your next quarter of content with us today.";

export function website(overrides: Partial<WebsiteResearch> = {}): WebsiteResearch {
  return {
    source: "jina-reader",
    url: "https://acme.com/",
    finalUrl: "https://acme.com/",
    httpStatus: 200,
    title: "Acme Content | B2B Technical Content Marketing Agency",
    description: "Technical content marketing for B2B software companies.",
    language: "en",
    canonical: "https://acme.com/",
    metaRobots: "index, follow",
    openGraph: {},
    twitter: {},
    headings: [
      { level: 1, text: "Technical content that converts", followingText: null },
      { level: 2, text: "Developer documentation", followingText: null },
    ],
    links: [],
    structuredData: { types: ["Organization"], items: [{ "@type": "Organization", name: "Acme Content", description: "A B2B content marketing agency." }], invalidBlocks: 0 },
    robotsTxt: null,
    content: TEXT,
    contentTruncated: false,
    wordCount: TEXT.split(" ").length,
    copyrightYear: null,
    fetchedAt: "2026-10-02T00:00:00.000Z",
    ...overrides,
  };
}

export const CATEGORY: CategoryResult = {
  category: "Content Marketing Agency",
  subcategory: "B2B Technical Content Marketing Agency",
  confidence: 0.9,
  rationale: "The site describes itself as a B2B technical content marketing agency.",
  evidence: ["B2B technical content marketing agency"],
  model: "fake:fake-model",
  detectedAt: "2026-10-02T00:00:00.000Z",
};

/** A good LLM category answer for the website() fixture. */
export const categoryAnswer = (overrides: Record<string, unknown> = {}) => ({
  category: "Content Marketing Agency",
  subcategory: "B2B Technical Content Marketing Agency",
  confidence: 0.88,
  rationale: "The homepage calls the company a B2B technical content marketing agency for software companies.",
  evidence: ["B2B technical content marketing agency", "developer documentation"],
  ...overrides,
});

/**
 * Real Tavily results from Carrd's research (carrd.co, 2026-10-08), with
 * the verdict each got before onepagelove.com was gated: onepagelove was "selected (deterministic)".
 */
export const CARRD_CATEGORY: CategoryResult = {
  ...CATEGORY,
  category: "One-Page Website Builder",
  subcategory: "Simple One-Page Site Builder",
  rationale: "The site describes Carrd as a platform for building simple, fully responsive one-page sites for any purpose.",
  evidence: ["Simple, free, fully responsive one-page sites for pretty much anything"],
};
export const CARRD_RESULTS: SearchResult[] = [
  result("https://www.yola.com", "Make a Free Website - Free Website Builder - Yola", "Get started\n\n \n\n> Yola is excellent. Creating websites is easy and straightforward. The websites produced look professional and their help desk people are fantastic. They are prompt and always resolve issues. They have the best help desk service of any company I’ve come across. All in all I highly recommend Yola.\n\nBryn Lloyd Jones\n\nwww.homedryroofing.co.uk [...] 1. 1.\n\n   Pick the right website builder. Choose a secure, reliable platform like Yola where you can design, host, and manage your site in one place.\n2. 2.\n\n   Clarify your goal. Decide what your website should achieve — showcase services, sell products, collect leads, or build credibility.\n3. 3.\n\n   Outline your pages. Plan a simple structure (Home, About, Services, Contact, Store, etc.) to keep your content focused and easy to navigate.\n4. 4. [...] A website builder is an online tool that lets you create, design, and publish a website without coding. With Yola's free website builder, you can choose a template or use AI, customize your pages with drag-and-drop tools, and go live in minutes.\n\n    \n\n### How do I make a website for my business?\n\n   \n\nStart by describing your business or selecting a template. Add your content, adjust the design to match your brand, connect a domain, and publish — all inside the Yola website builder.", 0.31621137),
  result("https://onepagelove.com", "One Page Love — One Page Website Inspiration and Templates", "Skip to content\n\n# One Page websites, curated\n\n9,160 sites and 9,274 section examples, hand-picked since 2008.\n\nCongrue Thumbnail Preview\n\n## Congrue\n\nLanding Page SaaS Startup\n\nGrilled Pixels Ecommerce Thumbnail Preview\n\n## Grilled Pixels Ecommerce\n\nE-commerce Landing Page Portfolio\n\nBuild better sites fasterSponsored\n\n## Build better sites faster\n\nRecommended website builder\n\nRoy Jad Thumbnail Preview\n\n## Roy Jad\n\nPortfolio\n\nDabbit Thumbnail Preview\n\n## Dabbit\n\nLanding Page [...] Landing Page\n\nSelect26 Thumbnail Preview\n\n## Select26\n\nEvent Landing Page\n\nApplied Imagination Thumbnail Preview\n\n## Applied Imagination\n\nLanding Page Long-form Journalism One Page Blog\n\nBob Moll Thumbnail Preview\n\n## Bob Moll\n\nMusic Related\n\nUncle Rudy Thumbnail Preview\n\n## Uncle Rudy\n\nApp Landing Page\n\nYou have reached the end (head home)\n\nYou have reached the end (head home)", 0.7253574),
  result("https://onepage.io", "Onepage - Page building software that boosts your productivity | Onepage", "Top platform for modern web design! Onepage.io is super easy to use and offers exactly the functions you need for a professional website. I especially like the clear, intuitive interface. You can get started right away even without much prior knowledge. The templates look modern, can be customized flexibly, and are perfect for companies that want to become visible online quickly. The support is friendly, fast, and solution-oriented. The integration of tools such as newsletters or payment [...] Create your own templates. Adjust them with ease\n\nAll you need to do is adjust the content and apply new styles with a few clicks. It saves time and reduces the costs per project\n\nFormal\n\nVazirmatn\n\nModern\n\nPopims, Mule\n\nDirect\n\nFugaz One, Roboto Slab\n\nDedicate design work to less experienced employees\n\nProject-managers, analysts and junior staff are able to create decent-looking projects in Onepage, so you can save time and money from expensive hires\n\nWin new customers by offering more value [...] What I especially like is the ease of use and the intuitive user interface. I think many people dread creating a website, fearing it will be super complicated—but with Onepage, that’s absolutely not the case! The application is very simple, and creating websites is genuinely fun. The platform is constantly being improved, and I can wholeheartedly recommend it to any freelancer looking to build their own website.\n\nV\n\nVanessa\n\nMarketing & Advertising Professional\n\nOnepage is simply top-notch", 0.57236487),
  result("https://www.squarespace.com", "Website Builder – Easily Create Your Own Website — Squarespace", "For example, your website comes with default SEO page titles and descriptions, which you can modify without changing the page content visitors see. You can also hide pages if you need to, and control the image people see alongside your content whenever it's shared on social media.\n\nWith the help of Squarespace AI, you can also generate SEO-friendly website copy and image alt text. [...] Connect a custom domain name, publish your site, and start building your audience with built-in marketing tools, including SEO, email marketing, and social media connections.\n6. ### Start selling online\n\n   Create an online store and allow customers to browse your products or services, add items to their shopping cart, and check out securely and efficiently with Squarespace Payments. [...] Add content to your site with AI tools or write your own. Finally, find a custom domain name and publish your website. Then start growing your audience with Squarespace marketing tools or sell products through your own online store.", 0.41705835),
  result("https://www.wix.com/builder/one-page", "One-Page Website Builder: Build A Site For Free - Wix", "### What is a one-page website builder?\n\nA one-page website builder is a user-friendly tool that simplifies the creation of concise and impactful single-page websites. It eliminates the need for extensive coding skills.\n\n### What is the best one-page website builder?\n\nWix is recognized as one of the best one-page website builders, offering simplicity, versatility, and a range of features to bring your narrative to life seamlessly.\n\n### How much does it cost to build a one-page website? [...] A one-page website is ideal when you want visitors to get everything they need in a single, fast-scrolling experience. It’s a great fit for promoting a service, showcasing an event or creating a simple lead-generation page. With Wix, you can design a focused salon one page website that collects leads, set up a church site that showcases service times and announcements or build a streamlined non-profit page that highlights your mission and encourages support with donation features. You control [...] A one-page website is ideal for concise storytelling, ensuring your audience quickly grasps your message. It's perfect for portfolios, event pages, and small businesses.\n\n### How long does it take to build a website with a one-page website builder?\n\nUsing Wix's one-page website builder, you can have a captivating website up and running in just a few hours. Alternatively, you can use our AI website creator to generate a website and get online even faster.\n\n## One page. Endless possibilities.", 0.7732339),
  result("https://www.experte.com/website-builder", "14 Best Website Builders for 2026 - Tested & Ranked | EXPERTE.com", "high price\n\ncomplex for beginners\n\nReview\n\ngood\n\nStorage\n\nunlimited\n\nDomains\n\n0 domains\n\nPages\n\n1,000 pages\n\nContract period\n\n1 - 12 months\n\nDuda.co Basic\n\n+ 6 more plans\n\neffective monthly price ?\n\nStrikingly Website Builder\n\nStrikingly Website Builder\n\n(116 ratings)\n\nStrikingly is a beginner-friendly website builder designed for creating one-pagers and landing pages. These days, it can also handle multipage websites – however, for complex websites, other platforms are better.\n\n180+ templates [...] 10 / 10\n\nEase of use (25%)\n\n8.8 / 10\n\nSupport (10%)\n\n8.6 / 10\n\nAdvanced features (25%)\n\n8.2 / 10\n\nPricing (10%)\n\n4.4 / 10\n\n5.\n\n### Strikingly: Simple Website Builder for Simple Sites\n\nStrikingly Website Builder\n\nStrikingly Website Builder\n\n(116 ratings)\n\nStrikingly is a beginner-friendly website builder designed for creating one-pagers and landing pages. These days, it can also handle multipage websites – however, for complex websites, other platforms are better.\n\n180+ templates [...] Strikingly is worth a look if you're searching for an affordable website builder for one-pagers and simple sites that aren't going to win any design awards. Whether it's a hobby project, startup site, or mini-shop, Strikingly is best when you quickly need something professional looking.\n\nHowever, Strikingly isn't for more demanding users who want to create unique websites. Its features and design tools are just too basic for that.\n\nReview\n\n8.3\n\ngood\n\nCheck Review\n\nSupport (10%)\n\n9.5 / 10", 0.7578844),
  result("https://www.seedprod.com/free-one-page-website-builders", "9 Free One-Page Website Builders, Tested: My Honest Take", "SeedProd is the top pick. Carrd or Strikingly are the fastest way to publish. Choose a standalone builder (Strikingly, Wix, Weebly, Site123, IM", 0.90633047),
  result("https://zapier.com/blog/best-landing-page-builders", "The 7 best landing page builders in 2026 | Zapier", "Carrd is one of the best landing page builders out there—and most of its core features are available for free. You don't even need an account to start building a page. Just head to the Carrd website, select one of the themes, and get to it. When you're ready to save or publish your site, that's when you'll need to sign up. [...] So, what makes great landing page building software? As someone who's been making sites for the last 20 years, writing about them for over a decade, and proselytizing about how good landing page builders are for more than five years, here's what I was looking for when testing:\n\nApps that enable you to build one-page websites that are easy to tweak and customize without any serious coding. Using CSS to style your site should be an optional extra, not required to get it off the ground. [...] Instapage is one of the best landing page builders available. For a while, its price crept north of $300/month, which made it impossible to recommend. The good news is that its entry plan is now back down to $99/month (and only $79/month if you pay for a year in advance). While still a serious investment, for businesses with the budget to invest in a premium landing page tool, it might be worth it.", 0.459586),
  result("https://launchthedamnthing.com/blog/best-website-builders", "7 Best Website Builders for 2026 (& Why None of them Are AI)", "Since there’s truly no one perfect or best platform for everyone (only the ‘best platform’ for your project), these are listed in order of how much I’ve personally used each of these platforms (from most to least), not in order of “best” to “worst.” For each one, I’ll share my opinions, important advantages and disadvantages, and who I believe it will work best for.\n\n### 1. Squarespace – Best All-In-One Builder for Small Businesses\n\nALL-IN-ONE  •   EASY  •   AFFORDABLE [...] GoDaddy’s Website Builder\n GoDaddy’s Airo (AI-powered builder),\n Kajabi and similar platforms which include basic website builders,\n ‘blogging’ platforms like Substack or Medium,\n miscellaneous other platforms that can build customizable public pages like Notion and ‘make’ them websites [...] Squarespace is the best all-in-one option I’ve ever found, and it works really well for small businesses in pretty much any industry. It combines a professional looking design, with solid SEO options throughout, and built-in features that businesses usually need, like: invoicing, scheduling, basic email marketing, contact forms, blogging, etc., all under one subscription and with a price tag that’s genuinely hard to beat.", 0.61057013),
  result("https://www.godaddy.com/websites/website-builder", "Criar Site Grátis: Use O Criador De Sites Em Poucos Passos GoDaddy", "OfertasAjuda\n\n Fale conosco\n\nCentral de Ajuda\n\nIniciar sessão\n\nUsuários registrados\n\nTem uma conta? Faça login agora.\n\nIniciar sessão\n\nNovo cliente\n\nPrimeira vez na GoDaddy? Crie uma conta e comece hoje mesmo.\n\nCriar conta\n\nLINKS NA CAIXA DE ENTRADA\n\n Inscrever-se no Email Office 365\n Inscrever-se no Webmail da GoDaddy", 0.083418936),
];

/** Kittl's homepage as read by Jina (kittl.com, 2026-10-08; headings and visible text cut). */
const KITTL_TEXT =
  "Features AI Creative Suite AI Workflows Proven shortcuts for merch, marketing and video AI Image Generator Turn ideas into polished images AI Vector Generator Create clean, editable vector artwork AI Video Generator Generate and animate using Video AI Agentic AI Your creative agent for complete design tasks Background Remover Cleanly remove backgrounds in seconds Image Upscaler Turn low-res images into high-def assets Vectorizer Transform any image into scalable paths Editor Infinite Canvas Endless space to create Collaboration Create together, in real time Text Effects Apply instant styles to text Kittl Brand Studio Build your brand once. Generate ads, posts, campaigns, all on-brand. For For Small Businesses Logo Maker Business Cards Menus Packaging Product Labels Product Tags Product Visuals For Sellers T-shirts Hoodies Posters Product Mockups Shopify Banners Etsy Banners Etsy Listings";

export const kittlWebsite = () =>
  website({
    url: "https://kittl.com/",
    finalUrl: "https://www.kittl.com/",
    title: "Kittl | The AI-First Design Platform for Creators",
    description: "Kittl is the AI design platform built for creativity. Create with top image gen models, pro editing tools, mockups, and curated assets — free to start.",
    canonical: "https://www.kittl.com/",
    headings: [
      "h1: AI-Powered Design for Ambitious Brands", "h4: Sales-ready designs", "h4: Listing-ready mockups", "h4: High-converting visuals",
      "h4: Scroll-stopping UGC", "h4: Attention-grabbing ads", "h2: Made for people with products to sell.", "h3: POD Sellers",
      "h3: Small Businesses", "h3: Agencies", "h2: Everything you need to go from design to sale.", "h3: AI video generation",
    ].map((h) => ({ level: Number(h[1]) as WebsiteHeading["level"], text: h.slice(4), followingText: null })),
    structuredData: { types: [], items: [], invalidBlocks: 0 },
    content: KITTL_TEXT,
    wordCount: KITTL_TEXT.split(" ").length,
  });

/** What openai/gpt-oss-120b returned for kittl.com on 2026-10-08 (3 of 3 runs: 6–7 quotes; this one has 7). */
export const kittlAnswer = () => ({
  category: "AI Design Platform",
  subcategory: "AI-Powered Graphic Design Tool for Brands and Sellers",
  confidence: 0.96,
  rationale:
    "The site describes Kittl as an AI‑first design platform that lets creators, businesses and agencies generate branding, product visuals, mockups and ads. It emphasizes AI image, vector and video generation plus templates for sales‑ready designs.",
  evidence: [
    "Kittl | The AI-First Design Platform for Creators",
    "AI‑Powered Design for Ambitious Brands",
    "AI Image Generator Turn ideas into polished images",
    "AI Vector Generator Create clean, editable vector artwork",
    "AI Video Generator Generate and animate using Video AI",
    "Made for people with products to sell.",
    "For Small Businesses … For Sellers … For Agencies",
  ],
});
