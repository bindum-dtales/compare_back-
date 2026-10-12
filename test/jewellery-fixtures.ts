// thejewelleryshow.in (category detection failed: "The website doesn't have enough readable content"),
// captured through Jina Reader keyless on 2026-10-10. Sanitized: tracking snippets, street address
// and phone numbers removed, the repeated testimonial carousel cut to one slide.
//
// SHELL_HTML: the homepage's HTML read (and, as text, its cached text read): a create-react-app shell.
// RENDERED_TEXT / RENDERED_LINKS: an uncached text read with X-With-Links-Summary (the app rendered).

export const DOMAIN = "thejewelleryshow.in";

export const SHELL_HTML = "<html lang=\"en\"><head><meta charset=\"utf-8\"><link rel=\"icon\" href=\"/favicon.ico\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"theme-color\" content=\"#000000\"><meta name=\"description\" content=\"India’s Top Jewellery Exhibition Organiser\"><link rel=\"apple-touch-icon\" href=\"/jslogo.png\"><link rel=\"manifest\" href=\"/jslogo.png\"><link rel=\"stylesheet\" href=\"https://stackpath.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css\" crossorigin=\"anonymous\"><link rel=\"stylesheet\" href=\"//cdn.quilljs.com/1.2.6/quill.snow.css\"><title>The Jewellery Show</title><script defer=\"defer\" src=\"/static/js/main.169b3057.js\"></script><link href=\"/static/css/main.11e9cc02.css\" rel=\"stylesheet\"></head><body><noscript>You need to enable JavaScript to run this app.</noscript><div id=\"root\"></div></body><script src=\"https://cdnjs.cloudflare.com/ajax/libs/flowbite/1.6.5/flowbite.min.js\"></script></html>";

export const SHELL_TEXT = "You need to enable JavaScript to run this app.\n";

export const RENDERED_TEXT = "Jewellery Show\nTypically replies within 1 hour\n\nUpcoming Event\n\n12 - 14 November 2026\n\nHubballi\n|\n33\n\nDays\n07\n\nHours\n4\n\nMinutes\n43\n\nSeconds\nHome\nPrevious Show\nUpcoming Events\nGallery\nBlogs\nContact\nRegister Now\nSubmit\nUpcoming Events\nHubballi\n12- 13- 14 November 2026\n\nThe Jewellery Show @ Hubballi 2026\n\nSHOW MORE\nTrusted by brands all over the country\n Previous\n Next\n38th edition luxurious collections\n\nThe practical platform for display & sale of spectacular Gold, Diamond, Platinum, Gems, Pearls & Silver Jewellery.\n\nKnow More\n100+\n\nAssociated Jewellers\n\n25+\n\nShows\n\n100000+\n\nVisitors\n\nOur Happy Customers\nsays about us\n Previous\n\n“The Jewellery Show\" Exhibition, held across various cities in Karnataka, has undoubtedly emerged as one of the most celebrated jewellery events in India, bringing together the finest Artisans, Designers, and Industry experts from all corners of the country. This year’s edition has set a new benchmark for excellence, showcasing not just the exquisite craftsmanship of India’s top jewellery designers but also introducing international standards and creativity to the local market. From Bengaluru to Mangaluru, Hubli, Mysuru, Tumkuru, Chikkmangluru, Davanagere, Ballari each city is transformed into a glittering showcase of jewellery art, where the fusion of tradition and innovation is palpable. The exhibition featured over Top Participants from across India, each bringing their unique flair and vision, making the event an unparalleled experience for collectors, jewellery lovers, and even first-time visitors. \" One Show For ALL Celebrations \"\n\nBrand Ambassador 2025\n\nFollow Us On\n\nHome\nUpcoming Events\nGallery\nBlogs\nContact\nGolden Creeper Enterprises\nBengaluru (Bangalore) Urban\n\n© 2025 GOLDEN CREEPER ENTERPRISES\n";

export const RENDERED_LINKS: Record<string, string> = {
  "2018": "https://thejewelleryshow.in/events2018",
  "2019": "https://thejewelleryshow.in/page2019",
  "2020": "https://thejewelleryshow.in/event2020",
  "2021": "https://thejewelleryshow.in/events2021",
  "2022": "https://thejewelleryshow.in/page2022",
  "2023": "https://thejewelleryshow.in/page2023",
  "2024": "https://thejewelleryshow.in/page2024",
  "2025": "https://thejewelleryshow.in/page2025",
  "Home": "https://thejewelleryshow.in/",
  "Previous Show": "https://thejewelleryshow.in/#",
  "Upcoming Events": "https://thejewelleryshow.in/upcomingshow",
  "Gallery": "https://thejewelleryshow.in/gallery",
  "Blogs": "https://thejewelleryshow.in/blogs",
  "Contact": "https://thejewelleryshow.in/contact",
  "Show More": "https://thejewelleryshow.in/showpage/The_Jewellery_Show_@_Hubballi_2026"
};

/** A category answer for the rendered text; quotes copied from RENDERED_TEXT (with its curly quotes and line breaks). */
export const jewelleryAnswer = (overrides: Record<string, unknown> = {}) => ({
  category: "Jewellery Exhibition Organiser",
  subcategory: "Regional Jewellery Trade and Consumer Shows in Karnataka",
  confidence: 0.9,
  rationale: "The site describes a jewellery exhibition held across cities in Karnataka for display and sale of jewellery.",
  evidence: [
    "India’s Top Jewellery Exhibition Organiser",
    "The practical platform for display & sale of spectacular Gold, Diamond, Platinum, Gems, Pearls & Silver Jewellery.",
    "\u201cThe Jewellery Show\" Exhibition, held across various cities in Karnataka",
  ],
  ...overrides,
});
