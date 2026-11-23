import type { Lang } from '../types/marketplace';

export const copy = {
  bn: {
    partnerCta: 'রেস্টুরেন্ট পার্টনার হোন',
    riderCta: 'রাইডার পোর্টাল',
    adminCta: 'অ্যাডমিন প্যানেল',
    selectAddress: 'আপনার ঠিকানা নির্বাচন করুন',
    login: 'লগইন',
    signup: 'সাইন আপ',
    delivery: 'ডেলিভারি',
    pickup: 'পিক আপ',
    searchPlaceholder: 'রেস্টুরেন্ট, শহর, কুইজিন বা খাবার খুঁজুন (ঢাকা ও সারাদেশ)...',
    heroBadge: 'সারাদেশে ডেলিভারি অফার',
    heroHeadline: 'ঢাকা ও বাংলাদেশের যেকোনো শহরে অর্ডার করুন ৫০% ছাড়ে',
    heroSub: 'ঢাকা, চট্টগ্রাম, সিলেট, রাজশাহী, খুলনা, বরিশাল, রংপুর, ময়মনসিংহসহ বাংলাদেশের যেকোনো এলাকার সেরা রেস্টুরেন্ট থেকে দ্রুত খাবার ডেলিভারি।',
    heroBtn: 'অর্ডার করুন',
    heroTrust: 'সারাদেশে ডেলিভারি · বিকাশ ও নগদ পেমেন্ট · লাইভ রাইডার ট্র্যাকিং · ইমেইল ট্র্যাকিং',
    favCuisines: 'আপনার পছন্দের কুইজিন',
    dailyDeals: 'আপনার প্রতিদিনের ভাউচার ও ডিল',
    allRestaurants: 'সব রেস্টুরেন্ট',
    filters: 'ফিল্টার',
    sortBy: 'সাজান',
    relevance: 'জনপ্রিয়তা',
    rating: 'সেরা রেটিং',
    fastest: 'দ্রুত ডেলিভারি',
    lowFee: 'কম ডেলিভারি ফি',
    offers: 'অফার ও ছাড়',
    hasDiscount: 'ডিসকাউন্ট অফার',
    freeFirstOrder: 'ফ্রি ডেলিভারি অফার',
    priceRange: 'দামের ধরন',
    deliveryFilter: 'ডেলিভারি পার্টনার',
    cuisineFilter: 'কুইজিন',
    clearFilters: 'সব রিসেট করুন',
    sponsored: 'বিজ্ঞাপন',
    newBadge: 'নতুন',
    minFrom: 'মিনিট',
    firstOrderFree: 'ফ্রি ডেলিভারি ডিল',
    discountOff: '% ছাড়',
    noResults: 'কোনো রেস্টুরেন্ট পাওয়া যায়নি',
    cart: 'কার্ট',
    checkout: 'চেকআউট করুন',
    addToCart: 'কার্টে যোগ করুন',
    myOrders: 'আমার অর্ডার',
    myAccount: 'আমার প্রোফাইল',
    minOrderLabel: 'ন্যূনতম অর্ডার',
  },
  en: {
    partnerCta: 'Become a Restaurant Partner',
    riderCta: 'Join as Rider (Job)',
    adminCta: 'Super Admin',
    selectAddress: 'Select Delivery Area Anywhere in Bangladesh',
    login: 'Log in',
    signup: 'Sign up',
    delivery: 'Delivery',
    pickup: 'Pickup',
    searchPlaceholder: 'Search restaurants, cities, cuisines & dishes across Bangladesh...',
    heroBadge: 'All Bangladesh Delivery',
    heroHeadline: 'Enjoy Free Delivery & 50% Off Across Bangladesh',
    heroSub: 'Order from top restaurants & cloud kitchens in Dhaka, Chattogram, Sylhet, Rajshahi, Khulna, Barishal, Rangpur, Mymensingh & any area in BD.',
    heroBtn: 'Order Now',
    heroTrust: 'Nationwide BD coverage · bKash & Nagad · Live rider GPS · Email order tracking',
    favCuisines: 'Explore by Cuisine',
    dailyDeals: 'Daily Vouchers & Deals',
    allRestaurants: 'All Restaurants',
    filters: 'Filters',
    sortBy: 'Sort by',
    relevance: 'Relevance',
    rating: 'Top Rated',
    fastest: 'Fastest Delivery',
    lowFee: 'Lowest Delivery Fee',
    offers: 'Offers & Deals',
    hasDiscount: 'Active Discounts',
    freeFirstOrder: 'Low / Free Delivery',
    priceRange: 'Price Tier',
    deliveryFilter: 'Delivery Fleet',
    cuisineFilter: 'Cuisines',
    clearFilters: 'Reset all',
    sponsored: 'Sponsored',
    newBadge: 'New',
    minFrom: 'mins',
    firstOrderFree: 'Free delivery deal',
    discountOff: '% off',
    noResults: 'No matching restaurants found',
    cart: 'Cart',
    checkout: 'Proceed to Checkout',
    addToCart: 'Add to Cart',
    myOrders: 'My Orders',
    myAccount: 'My Account',
    minOrderLabel: 'Min order',
  },
} as const;

export function t(lang: Lang, key: keyof (typeof copy)['bn']): string {
  return copy[lang][key];
}

export function localizeCouponTitle(code: string, dbTitle: string, lang: Lang): string {
  const upper = code.trim().toUpperCase();
  if (lang === 'en') {
    if (upper === 'FOODORA50') return '50% off on your 1st order (up to ৳150)';
    if (upper === 'DHAKA15') return 'Flat 15% off across Bangladesh restaurants';
    if (upper === 'FREEDEL') return 'Free delivery on orders of ৳200+';
  }
  return dbTitle;
}

export interface BangladeshAreaPreset {
  name: string;
  nameBn: string;
  division: string;
  zoneCode?: string;
  zoneLabel?: string;
  lat: number;
  lng: number;
}

export interface DhakaDeliveryZone {
  code: string;
  name: string;
  nameBn: string;
  summary: string;
  areas: BangladeshAreaPreset[];
}

export const DHAKA_DELIVERY_ZONES: DhakaDeliveryZone[] = [
  {
    code: 'ZONE 01',
    name: 'GULSHAN',
    nameBn: 'গুলশান',
    summary: 'Gulshan 1, Gulshan 2, Niketan, Shahjadpur',
    areas: [
      { name: 'Gulshan 2', nameBn: 'গুলশান ২', division: 'Dhaka', zoneCode: 'ZONE 01', zoneLabel: 'ZONE 01 — GULSHAN', lat: 23.7949, lng: 90.4144 },
      { name: 'Gulshan 1', nameBn: 'গুলশান ১', division: 'Dhaka', zoneCode: 'ZONE 01', zoneLabel: 'ZONE 01 — GULSHAN', lat: 23.7811, lng: 90.4167 },
      { name: 'Niketan', nameBn: 'নিকেতন', division: 'Dhaka', zoneCode: 'ZONE 01', zoneLabel: 'ZONE 01 — GULSHAN', lat: 23.7764, lng: 90.4098 },
      { name: 'Shahjadpur', nameBn: 'শাহজাদপুর', division: 'Dhaka', zoneCode: 'ZONE 01', zoneLabel: 'ZONE 01 — GULSHAN', lat: 23.7985, lng: 90.4256 },
    ],
  },
  {
    code: 'ZONE 02',
    name: 'BANANI',
    nameBn: 'বনানী',
    summary: 'Banani 1–27, Chairman Bari, Kakoli',
    areas: [
      { name: 'Banani', nameBn: 'বনানী', division: 'Dhaka', zoneCode: 'ZONE 02', zoneLabel: 'ZONE 02 — BANANI', lat: 23.7937, lng: 90.4066 },
      { name: 'Banani 1–27', nameBn: 'বনানী ১–২৭', division: 'Dhaka', zoneCode: 'ZONE 02', zoneLabel: 'ZONE 02 — BANANI', lat: 23.7942, lng: 90.4045 },
      { name: 'Chairman Bari', nameBn: 'চেয়ারম্যান বাড়ি', division: 'Dhaka', zoneCode: 'ZONE 02', zoneLabel: 'ZONE 02 — BANANI', lat: 23.7916, lng: 90.4021 },
      { name: 'Kakoli', nameBn: 'কাকলী', division: 'Dhaka', zoneCode: 'ZONE 02', zoneLabel: 'ZONE 02 — BANANI', lat: 23.7983, lng: 90.4008 },
    ],
  },
  {
    code: 'ZONE 03',
    name: 'DHANMONDI',
    nameBn: 'ধানমন্ডি',
    summary: 'Dhanmondi 1–32, Satmasjid Road, Jigatola, Kalabagan',
    areas: [
      { name: 'Dhanmondi 27', nameBn: 'ধানমন্ডি ২৭', division: 'Dhaka', zoneCode: 'ZONE 03', zoneLabel: 'ZONE 03 — DHANMONDI', lat: 23.7518, lng: 90.3712 },
      { name: 'Dhanmondi 1–32', nameBn: 'ধানমন্ডি ১–৩২', division: 'Dhaka', zoneCode: 'ZONE 03', zoneLabel: 'ZONE 03 — DHANMONDI', lat: 23.7461, lng: 90.3742 },
      { name: 'Satmasjid Road', nameBn: 'সাতমসজিদ রোড', division: 'Dhaka', zoneCode: 'ZONE 03', zoneLabel: 'ZONE 03 — DHANMONDI', lat: 23.7458, lng: 90.3698 },
      { name: 'Jigatola', nameBn: 'জিগাতলা', division: 'Dhaka', zoneCode: 'ZONE 03', zoneLabel: 'ZONE 03 — DHANMONDI', lat: 23.7397, lng: 90.3728 },
      { name: 'Kalabagan', nameBn: 'কলাবাগান', division: 'Dhaka', zoneCode: 'ZONE 03', zoneLabel: 'ZONE 03 — DHANMONDI', lat: 23.7495, lng: 90.3822 },
    ],
  },
  {
    code: 'ZONE 04',
    name: 'MIRPUR',
    nameBn: 'মিরপুর',
    summary: 'Mirpur 1, 2, 6, 10, 11, 12, Pallabi, Kazipara',
    areas: [
      { name: 'Mirpur 10', nameBn: 'মিরপুর ১০', division: 'Dhaka', zoneCode: 'ZONE 04', zoneLabel: 'ZONE 04 — MIRPUR', lat: 23.8069, lng: 90.3687 },
      { name: 'Mirpur 1', nameBn: 'মিরপুর ১', division: 'Dhaka', zoneCode: 'ZONE 04', zoneLabel: 'ZONE 04 — MIRPUR', lat: 23.7984, lng: 90.3536 },
      { name: 'Mirpur 2', nameBn: 'মিরপুর ২', division: 'Dhaka', zoneCode: 'ZONE 04', zoneLabel: 'ZONE 04 — MIRPUR', lat: 23.8045, lng: 90.3612 },
      { name: 'Mirpur 6', nameBn: 'মিরপুর ৬', division: 'Dhaka', zoneCode: 'ZONE 04', zoneLabel: 'ZONE 04 — MIRPUR', lat: 23.8124, lng: 90.3638 },
      { name: 'Mirpur 11', nameBn: 'মিরপুর ১১', division: 'Dhaka', zoneCode: 'ZONE 04', zoneLabel: 'ZONE 04 — MIRPUR', lat: 23.8186, lng: 90.3652 },
      { name: 'Mirpur 12', nameBn: 'মিরপুর ১২', division: 'Dhaka', zoneCode: 'ZONE 04', zoneLabel: 'ZONE 04 — MIRPUR', lat: 23.8286, lng: 90.3641 },
      { name: 'Pallabi', nameBn: 'পল্লবী', division: 'Dhaka', zoneCode: 'ZONE 04', zoneLabel: 'ZONE 04 — MIRPUR', lat: 23.8256, lng: 90.3602 },
      { name: 'Kazipara', nameBn: 'কাজীপাড়া', division: 'Dhaka', zoneCode: 'ZONE 04', zoneLabel: 'ZONE 04 — MIRPUR', lat: 23.7966, lng: 90.3735 },
    ],
  },
  {
    code: 'ZONE 05',
    name: 'UTTARA',
    nameBn: 'উত্তরা',
    summary: 'Sectors 1–14, Rajlaxmi, Jashimuddin, Abdullahpur',
    areas: [
      { name: 'Uttara Sector 7', nameBn: 'উত্তরা সেক্টর ৭', division: 'Dhaka', zoneCode: 'ZONE 05', zoneLabel: 'ZONE 05 — UTTARA', lat: 23.8682, lng: 90.3991 },
      { name: 'Uttara Sectors 1–14', nameBn: 'উত্তরা সেক্টর ১–১৪', division: 'Dhaka', zoneCode: 'ZONE 05', zoneLabel: 'ZONE 05 — UTTARA', lat: 23.8722, lng: 90.3965 },
      { name: 'Rajlaxmi', nameBn: 'রাজলক্ষ্মী', division: 'Dhaka', zoneCode: 'ZONE 05', zoneLabel: 'ZONE 05 — UTTARA', lat: 23.8618, lng: 90.4003 },
      { name: 'Jashimuddin', nameBn: 'জসিমউদ্দীন', division: 'Dhaka', zoneCode: 'ZONE 05', zoneLabel: 'ZONE 05 — UTTARA', lat: 23.8602, lng: 90.4009 },
      { name: 'Abdullahpur', nameBn: 'আব্দুল্লাহপুর', division: 'Dhaka', zoneCode: 'ZONE 05', zoneLabel: 'ZONE 05 — UTTARA', lat: 23.8794, lng: 90.4012 },
    ],
  },
  {
    code: 'ZONE 06',
    name: 'MOHAMMADPUR',
    nameBn: 'মোহাম্মদপুর',
    summary: 'Mohammadpur, Town Hall, Bosila, Adabor, Shyamoli',
    areas: [
      { name: 'Mohammadpur', nameBn: 'মোহাম্মদপুর', division: 'Dhaka', zoneCode: 'ZONE 06', zoneLabel: 'ZONE 06 — MOHAMMADPUR', lat: 23.7658, lng: 90.3586 },
      { name: 'Town Hall', nameBn: 'টাউন হল', division: 'Dhaka', zoneCode: 'ZONE 06', zoneLabel: 'ZONE 06 — MOHAMMADPUR', lat: 23.7662, lng: 90.3621 },
      { name: 'Bosila', nameBn: 'বসিলা', division: 'Dhaka', zoneCode: 'ZONE 06', zoneLabel: 'ZONE 06 — MOHAMMADPUR', lat: 23.7484, lng: 90.3435 },
      { name: 'Adabor', nameBn: 'আদাবর', division: 'Dhaka', zoneCode: 'ZONE 06', zoneLabel: 'ZONE 06 — MOHAMMADPUR', lat: 23.7704, lng: 90.3568 },
      { name: 'Shyamoli', nameBn: 'শ্যামলী', division: 'Dhaka', zoneCode: 'ZONE 06', zoneLabel: 'ZONE 06 — MOHAMMADPUR', lat: 23.7745, lng: 90.3654 },
    ],
  },
  {
    code: 'ZONE 07',
    name: 'BASHUNDHARA',
    nameBn: 'বসুন্ধরা',
    summary: 'Bashundhara R/A, Jamuna Future Park, Kuril, Vatara',
    areas: [
      { name: 'Bashundhara R/A', nameBn: 'বসুন্ধরা আবাসিক এলাকা', division: 'Dhaka', zoneCode: 'ZONE 07', zoneLabel: 'ZONE 07 — BASHUNDHARA', lat: 23.8191, lng: 90.4526 },
      { name: 'Jamuna Future Park', nameBn: 'যমুনা ফিউচার পার্ক', division: 'Dhaka', zoneCode: 'ZONE 07', zoneLabel: 'ZONE 07 — BASHUNDHARA', lat: 23.8135, lng: 90.4242 },
      { name: 'Kuril', nameBn: 'কুড়িল', division: 'Dhaka', zoneCode: 'ZONE 07', zoneLabel: 'ZONE 07 — BASHUNDHARA', lat: 23.8204, lng: 90.4215 },
      { name: 'Vatara', nameBn: 'ভাটারা', division: 'Dhaka', zoneCode: 'ZONE 07', zoneLabel: 'ZONE 07 — BASHUNDHARA', lat: 23.8062, lng: 90.4285 },
    ],
  },
  {
    code: 'ZONE 08',
    name: 'BADDA',
    nameBn: 'বাড্ডা',
    summary: 'Badda, Merul Badda, Rampura, Aftabnagar',
    areas: [
      { name: 'Badda', nameBn: 'বাড্ডা', division: 'Dhaka', zoneCode: 'ZONE 08', zoneLabel: 'ZONE 08 — BADDA', lat: 23.7805, lng: 90.4267 },
      { name: 'Merul Badda', nameBn: 'মেরুল বাড্ডা', division: 'Dhaka', zoneCode: 'ZONE 08', zoneLabel: 'ZONE 08 — BADDA', lat: 23.7712, lng: 90.4252 },
      { name: 'Rampura', nameBn: 'রামপুরা', division: 'Dhaka', zoneCode: 'ZONE 08', zoneLabel: 'ZONE 08 — BADDA', lat: 23.7615, lng: 90.4208 },
      { name: 'Aftabnagar', nameBn: 'আফতাবনগর', division: 'Dhaka', zoneCode: 'ZONE 08', zoneLabel: 'ZONE 08 — BADDA', lat: 23.7654, lng: 90.4328 },
    ],
  },
  {
    code: 'ZONE 09',
    name: 'MOTIJHEEL',
    nameBn: 'মতিঝিল',
    summary: 'Motijheel, Paltan, Fakirapool, Arambagh, Kamalapur',
    areas: [
      { name: 'Motijheel', nameBn: 'মতিঝিল', division: 'Dhaka', zoneCode: 'ZONE 09', zoneLabel: 'ZONE 09 — MOTIJHEEL', lat: 23.7272, lng: 90.4198 },
      { name: 'Paltan', nameBn: 'পল্টন', division: 'Dhaka', zoneCode: 'ZONE 09', zoneLabel: 'ZONE 09 — MOTIJHEEL', lat: 23.7336, lng: 90.4119 },
      { name: 'Fakirapool', nameBn: 'ফকিরাপুল', division: 'Dhaka', zoneCode: 'ZONE 09', zoneLabel: 'ZONE 09 — MOTIJHEEL', lat: 23.7332, lng: 90.4178 },
      { name: 'Arambagh', nameBn: 'আরামবাগ', division: 'Dhaka', zoneCode: 'ZONE 09', zoneLabel: 'ZONE 09 — MOTIJHEEL', lat: 23.7311, lng: 90.4221 },
      { name: 'Kamalapur', nameBn: 'কমলাপুর', division: 'Dhaka', zoneCode: 'ZONE 09', zoneLabel: 'ZONE 09 — MOTIJHEEL', lat: 23.7318, lng: 90.4264 },
    ],
  },
  {
    code: 'ZONE 10',
    name: 'OLD DHAKA',
    nameBn: 'পুরান ঢাকা',
    summary: 'Chawkbazar, Bangshal, Lalbagh, Wari, Sutrapur',
    areas: [
      { name: 'Chawkbazar', nameBn: 'চকবাজার', division: 'Dhaka', zoneCode: 'ZONE 10', zoneLabel: 'ZONE 10 — OLD DHAKA', lat: 23.7158, lng: 90.3962 },
      { name: 'Bangshal', nameBn: 'বংশাল', division: 'Dhaka', zoneCode: 'ZONE 10', zoneLabel: 'ZONE 10 — OLD DHAKA', lat: 23.7186, lng: 90.4046 },
      { name: 'Lalbagh', nameBn: 'লালবাগ', division: 'Dhaka', zoneCode: 'ZONE 10', zoneLabel: 'ZONE 10 — OLD DHAKA', lat: 23.7189, lng: 90.3881 },
      { name: 'Wari', nameBn: 'ওয়ারী', division: 'Dhaka', zoneCode: 'ZONE 10', zoneLabel: 'ZONE 10 — OLD DHAKA', lat: 23.7178, lng: 90.4176 },
      { name: 'Sutrapur', nameBn: 'সূত্রাপুর', division: 'Dhaka', zoneCode: 'ZONE 10', zoneLabel: 'ZONE 10 — OLD DHAKA', lat: 23.7095, lng: 90.4138 },
    ],
  },
  {
    code: 'ZONE 11',
    name: 'TEJGAON / FARMGATE',
    nameBn: 'তেজগাঁও / ফার্মগেট',
    summary: 'Tejgaon, Farmgate, Karwan Bazar, Kawran Bazar',
    areas: [
      { name: 'Tejgaon', nameBn: 'তেজগাঁও', division: 'Dhaka', zoneCode: 'ZONE 11', zoneLabel: 'ZONE 11 — TEJGAON / FARMGATE', lat: 23.7612, lng: 90.3964 },
      { name: 'Farmgate', nameBn: 'ফার্মগেট', division: 'Dhaka', zoneCode: 'ZONE 11', zoneLabel: 'ZONE 11 — TEJGAON / FARMGATE', lat: 23.7561, lng: 90.3872 },
      { name: 'Karwan Bazar', nameBn: 'কারওয়ান বাজার', division: 'Dhaka', zoneCode: 'ZONE 11', zoneLabel: 'ZONE 11 — TEJGAON / FARMGATE', lat: 23.7514, lng: 90.3931 },
      { name: 'Kawran Bazar', nameBn: 'কাওরান বাজার', division: 'Dhaka', zoneCode: 'ZONE 11', zoneLabel: 'ZONE 11 — TEJGAON / FARMGATE', lat: 23.7521, lng: 90.3936 },
    ],
  },
  {
    code: 'ZONE 12',
    name: 'KHILGAON',
    nameBn: 'খিলগাঁও',
    summary: 'Khilgaon, Taltola, Malibagh, Goran & custom area',
    areas: [
      { name: 'Khilgaon', nameBn: 'খিলগাঁও', division: 'Dhaka', zoneCode: 'ZONE 12', zoneLabel: 'ZONE 12 — KHILGAON', lat: 23.7506, lng: 90.4254 },
      { name: 'Taltola', nameBn: 'তালতলা', division: 'Dhaka', zoneCode: 'ZONE 12', zoneLabel: 'ZONE 12 — KHILGAON', lat: 23.7532, lng: 90.4235 },
      { name: 'Malibagh', nameBn: 'মালিবাগ', division: 'Dhaka', zoneCode: 'ZONE 12', zoneLabel: 'ZONE 12 — KHILGAON', lat: 23.7478, lng: 90.4126 },
      { name: 'Goran', nameBn: 'গোরান', division: 'Dhaka', zoneCode: 'ZONE 12', zoneLabel: 'ZONE 12 — KHILGAON', lat: 23.7492, lng: 90.4335 },
    ],
  },
];

export const DHAKA_AREAS = DHAKA_DELIVERY_ZONES.map((z) => ({
  name: z.areas[0].name,
  nameBn: z.areas[0].nameBn,
  lat: z.areas[0].lat,
  lng: z.areas[0].lng,
}));

const NATIONWIDE_BD_AREAS: BangladeshAreaPreset[] = [
  { name: 'Chattogram (GEC / Agrabad)', nameBn: 'চট্টগ্রাম (জিইসি / আগ্রাবাদ)', division: 'Chattogram', zoneLabel: 'Nationwide Bangladesh Cities', lat: 22.3569, lng: 91.7832 },
  { name: 'Sylhet (Zindabazar)', nameBn: 'সিলেট (জিন্দাবাজার)', division: 'Sylhet', zoneLabel: 'Nationwide Bangladesh Cities', lat: 24.8949, lng: 91.8687 },
  { name: 'Rajshahi (Shaheb Bazar)', nameBn: 'রাজশাহী (সাহেব বাজার)', division: 'Rajshahi', zoneLabel: 'Nationwide Bangladesh Cities', lat: 24.3745, lng: 88.6042 },
  { name: 'Khulna (Shib Bari)', nameBn: 'খুলনা (শিববাড়ী)', division: 'Khulna', zoneLabel: 'Nationwide Bangladesh Cities', lat: 22.8456, lng: 89.5403 },
  { name: 'Barishal (Sadar)', nameBn: 'বরিশাল (সদর)', division: 'Barishal', zoneLabel: 'Nationwide Bangladesh Cities', lat: 22.701, lng: 90.3535 },
  { name: 'Rangpur (Jahaj Company)', nameBn: 'রংপুর (জাহাজ কোম্পানি)', division: 'Rangpur', zoneLabel: 'Nationwide Bangladesh Cities', lat: 25.7439, lng: 89.2752 },
  { name: 'Mymensingh (Town Hall)', nameBn: 'ময়মনসিংহ (টাউন হল)', division: 'Mymensingh', zoneLabel: 'Nationwide Bangladesh Cities', lat: 24.7471, lng: 90.4203 },
  { name: 'Narayanganj (Chashara)', nameBn: 'নারায়ণগঞ্জ (চাষাঢ়া)', division: 'Dhaka', zoneLabel: 'Nationwide Bangladesh Cities', lat: 23.6238, lng: 90.5 },
  { name: 'Gazipur (Joydebpur)', nameBn: 'গাজীপুর (জয়দেবপুর)', division: 'Dhaka', zoneLabel: 'Nationwide Bangladesh Cities', lat: 23.9999, lng: 90.4203 },
  { name: 'Savar (City Center)', nameBn: 'সাভার (সিটি সেন্টার)', division: 'Dhaka', zoneLabel: 'Nationwide Bangladesh Cities', lat: 23.8583, lng: 90.2667 },
  { name: 'Cumilla (Kandirpar)', nameBn: 'কুমিল্লা (কান্দিরপাড়)', division: 'Chattogram', zoneLabel: 'Nationwide Bangladesh Cities', lat: 23.4607, lng: 91.1809 },
  { name: "Cox's Bazar (Kolatoli)", nameBn: 'কক্সবাজার (কলাতলী)', division: 'Chattogram', zoneLabel: 'Nationwide Bangladesh Cities', lat: 21.4272, lng: 92.0058 },
  { name: 'Bogura (Satmatha)', nameBn: 'বগুড়া (সাতমাথা)', division: 'Rajshahi', zoneLabel: 'Nationwide Bangladesh Cities', lat: 24.8481, lng: 89.373 },
  { name: 'Jashore (Town)', nameBn: 'যশোর (শহর)', division: 'Khulna', zoneLabel: 'Nationwide Bangladesh Cities', lat: 23.1664, lng: 89.2081 },
];

export interface BangladeshLandmarkPreset extends BangladeshAreaPreset {
  keywords?: string;
  addressHint?: string;
}

export const BANGLADESH_LANDMARKS: BangladeshLandmarkPreset[] = [
  { name: 'Saad Musa City Center', nameBn: 'সাদ মুসা সিটি সেন্টার', division: 'Dhaka', zoneCode: 'ZONE 07', zoneLabel: 'Pragati Sarani · Kuril / Nikunja', addressHint: 'Ka-96-E Pragati Sarani, Kuril, Nikunja 1, Dhaka 1229', keywords: 'sad musa city center citycenter corporate tower kuril nikunja', lat: 23.81801, lng: 90.42001 },
  { name: 'Saad Musa Tower (Agrabad)', nameBn: 'সাদ মুসা টাওয়ার (আগ্রাবাদ)', division: 'Chattogram', zoneLabel: 'Agrabad C/A · Chattogram', addressHint: 'Agrabad Commercial Area, Chattogram', keywords: 'sad musa tower building commercial chittagong agrabad', lat: 22.3264, lng: 91.8122 },
  { name: 'Saad Musa Industrial Park', nameBn: 'সাদ মুসা ইন্ডাস্ট্রিয়াল পার্ক', division: 'Chattogram', zoneLabel: 'Kalurghat · Chattogram', addressHint: 'Kalurghat Heavy Industrial Area, Chattogram', keywords: 'sad musa group factory textile chittagong', lat: 22.3911, lng: 91.8842 },
  { name: 'Jamuna Future Park', nameBn: 'যমুনা ফিউচার পার্ক', division: 'Dhaka', zoneCode: 'ZONE 07', zoneLabel: 'ZONE 07 · Kuril / Bashundhara', addressHint: 'Ka-244 Pragati Sarani, Kuril, Dhaka 1229', keywords: 'futurepark shopping mall kuril bashundhara', lat: 23.8135, lng: 90.4242 },
  { name: 'Bashundhara City Shopping Complex', nameBn: 'বসুন্ধরা সিটি শপিং মল', division: 'Dhaka', zoneCode: 'ZONE 11', zoneLabel: 'Panthapath · Karwan Bazar', addressHint: 'Panthapath, West Karwan Bazar, Dhaka 1215', keywords: 'bashundhara city shopping mall panthapath farmgate', lat: 23.7509, lng: 90.3905 },
  { name: 'Police Plaza Concord', nameBn: 'পুলিশ প্লাজা কনকর্ড', division: 'Dhaka', zoneCode: 'ZONE 01', zoneLabel: 'Hatirjheel · Gulshan 1', addressHint: 'Plot 2, Road 144, Gulshan 1 (Hatirjheel Link), Dhaka 1212', keywords: 'policeplaza concord mall shopping tower gulshan', lat: 23.7731, lng: 90.4156 },
  { name: 'Gulshan Pink City Shopping Mall', nameBn: 'গুলশান পিংক সিটি', division: 'Dhaka', zoneCode: 'ZONE 01', zoneLabel: 'ZONE 01 · Gulshan 2', addressHint: 'Plot 15, Road 103, Gulshan Avenue, Dhaka 1212', keywords: 'pinkcity shopping mall gulshan 2', lat: 23.7924, lng: 90.4153 },
  { name: 'Navana Tower (Gulshan 1)', nameBn: 'নাভানা টাওয়ার (গুলশান ১)', division: 'Dhaka', zoneCode: 'ZONE 01', zoneLabel: 'ZONE 01 · Gulshan 1', addressHint: '45 Gulshan South C/A, Circle 1, Dhaka 1212', keywords: 'navana tower commercial office gulshan 1', lat: 23.7808, lng: 90.4169 },
  { name: 'Shimanto Square', nameBn: 'সীমান্ত স্কয়ার', division: 'Dhaka', zoneCode: 'ZONE 03', zoneLabel: 'ZONE 03 · Dhanmondi', addressHint: 'Road 2, Dhanmondi (Jigatola), Dhaka 1205', keywords: 'shimanto square rifles square shopping mall dhanmondi', lat: 23.7385, lng: 90.3752 },
  { name: 'Tokyo Square', nameBn: 'টোকিও স্কয়ার', division: 'Dhaka', zoneCode: 'ZONE 06', zoneLabel: 'ZONE 06 · Mohammadpur', addressHint: 'Japan Garden City, Ring Road, Mohammadpur, Dhaka 1207', keywords: 'tokyo square mall japan garden city mohammadpur', lat: 23.7689, lng: 90.3587 },
  { name: 'Mascot Plaza (Uttara)', nameBn: 'মাসকট প্লাজা (উত্তরা)', division: 'Dhaka', zoneCode: 'ZONE 05', zoneLabel: 'ZONE 05 · Uttara Sector 7', addressHint: 'Sector 7, Sonargaon Janapath, Uttara, Dhaka 1230', keywords: 'mascot plaza shopping mall uttara sector 7', lat: 23.8698, lng: 90.3999 },
  { name: 'Rajlokkhi Complex (Uttara)', nameBn: 'রাজলক্ষ্মী কমপ্লেক্স (উত্তরা)', division: 'Dhaka', zoneCode: 'ZONE 05', zoneLabel: 'ZONE 05 · Uttara Sector 3', addressHint: 'Sector 3, Dhaka-Mymensingh Hwy, Uttara, Dhaka 1230', keywords: 'rajlaxmi rajlokkhi complex market uttara', lat: 23.8644, lng: 90.4002 },
  { name: 'North Tower (Uttara)', nameBn: 'নর্থ টাওয়ার (উত্তরা)', division: 'Dhaka', zoneCode: 'ZONE 05', zoneLabel: 'ZONE 05 · Uttara Sector 7', addressHint: 'Sector 7, House Building, Uttara, Dhaka 1230', keywords: 'north tower shopping center uttara house building', lat: 23.8744, lng: 90.4005 },
  { name: 'Evercare Hospital Dhaka', nameBn: 'এভারকেয়ার হাসপাতাল ঢাকা', division: 'Dhaka', zoneCode: 'ZONE 07', zoneLabel: 'Bashundhara R/A', addressHint: 'Plot 81, Block E, Bashundhara R/A, Dhaka 1229', keywords: 'apollo hospital evercare medical bashundhara', lat: 23.8099, lng: 90.4314 },
  { name: 'United Hospital (Gulshan)', nameBn: 'ইউনাইটেড হাসপাতাল (গুলশান)', division: 'Dhaka', zoneCode: 'ZONE 01', zoneLabel: 'Gulshan 2', addressHint: 'Plot 15, Road 71, Gulshan 2, Dhaka 1212', keywords: 'united hospital medical gulshan 2', lat: 23.8047, lng: 90.4158 },
  { name: 'Square Hospital (Panthapath)', nameBn: 'স্কয়ার হাসপাতাল (পান্থপথ)', division: 'Dhaka', zoneCode: 'ZONE 03', zoneLabel: 'Panthapath · Dhanmondi', addressHint: '18/F Bir Uttam Qazi Nuruzzaman Sarak, Panthapath, Dhaka 1205', keywords: 'square hospital medical panthapath green road', lat: 23.7529, lng: 90.3816 },
  { name: 'Dhaka Medical College Hospital', nameBn: 'ঢাকা মেডিকেল কলেজ হাসপাতাল', division: 'Dhaka', zoneCode: 'ZONE 10', zoneLabel: 'Shahbagh · Bakshibazar', addressHint: 'Secretariat Road, Ramna / Shahbagh, Dhaka 1000', keywords: 'dmch medicalcollege hospital shahbagh buet', lat: 23.7259, lng: 90.3976 },
  { name: 'North South University (NSU)', nameBn: 'নর্থ সাউথ ইউনিভার্সিটি (NSU)', division: 'Dhaka', zoneCode: 'ZONE 07', zoneLabel: 'Bashundhara R/A', addressHint: 'Plot 15, Block B, Bashundhara R/A, Dhaka 1229', keywords: 'nsu north south university campus bashundhara', lat: 23.8151, lng: 90.4255 },
  { name: 'BRAC University (Merul Badda)', nameBn: 'ব্র্যাক ইউনিভার্সিটি (মেরুল বাড্ডা)', division: 'Dhaka', zoneCode: 'ZONE 08', zoneLabel: 'Merul Badda', addressHint: 'Kha 224 Bir Uttam Rafiqul Islam Ave, Merul Badda, Dhaka 1212', keywords: 'bracu brac university campus merul badda mohakhali', lat: 23.7725, lng: 90.4249 },
  { name: 'University of Dhaka (TSC / Shahbagh)', nameBn: 'ঢাকা বিশ্ববিদ্যালয় (টিএসসি)', division: 'Dhaka', zoneCode: 'ZONE 03', zoneLabel: 'Shahbagh · Nilkhet', addressHint: 'TSC Road, University of Dhaka, Shahbagh, Dhaka 1000', keywords: 'du dhaka university tsc shahbagh nilkhet', lat: 23.7339, lng: 90.3953 },
  { name: 'Hazrat Shahjalal International Airport', nameBn: 'হযরত শাহজালাল আন্তর্জাতিক বিমানবন্দর', division: 'Dhaka', zoneCode: 'ZONE 05', zoneLabel: 'Airport Road · Kurmitola', addressHint: 'Airport Road, Kurmitola, Dhaka 1229', keywords: 'hsia airport terminal 1 2 3 kurmitola dhaka', lat: 23.8433, lng: 90.3978 },
  { name: 'Kamalapur Railway Station', nameBn: 'কমলাপুর রেলওয়ে স্টেশন', division: 'Dhaka', zoneCode: 'ZONE 09', zoneLabel: 'Motijheel · Kamalapur', addressHint: 'Kamalapur Station Road, Motijheel, Dhaka 1217', keywords: 'railwaystation train station komlapur motijheel', lat: 23.7317, lng: 90.4262 },
  { name: 'Sanmar Ocean City (Chattogram)', nameBn: 'সানমার ওশান সিটি (চট্টগ্রাম)', division: 'Chattogram', zoneLabel: 'CDA Avenue · GEC Circle', addressHint: 'CDA Avenue, East Nasirabad, GEC Circle, Chattogram', keywords: 'sanmar oceancity mall gec chittagong', lat: 22.3596, lng: 91.8219 },
  { name: 'Al-Hamra Shopping City (Sylhet)', nameBn: 'আল-হামরা শপিং সিটি (সিলেট)', division: 'Sylhet', zoneLabel: 'Zindabazar · Sylhet', addressHint: 'Zindabazar Main Road, Sylhet 3100', keywords: 'al hamra shopping city mall zindabazar sylhet', lat: 24.8965, lng: 91.8682 },
];

export const BANGLADESH_AREAS: BangladeshAreaPreset[] = [
  ...DHAKA_DELIVERY_ZONES.flatMap((z) => z.areas),
  ...NATIONWIDE_BD_AREAS,
];

export const BANGLADESH_SEARCH_PLACES: BangladeshLandmarkPreset[] = [
  ...BANGLADESH_AREAS,
  ...BANGLADESH_LANDMARKS,
];

export function getBangladeshAreaSelectPresets(lang: Lang) {
  return BANGLADESH_AREAS.map((a) => ({
    value: a.name,
    label: lang === 'bn' ? `${a.nameBn} (${a.name})` : `${a.name} — ${a.nameBn}`,
    group: a.zoneLabel || `${a.division} Division`,
  }));
}

export const CUISINE_CATEGORIES = [
  { id: 'All', labelBn: 'সবগুলো', labelEn: 'All', img: '/src/assets/images/hero_dhaka_feast_1794831374659.jpg' },
  { id: 'Biriyani', labelBn: 'বিরিয়ানি', labelEn: 'Biriyani', img: '/src/assets/images/food_kacchi_biriyani_1794831373742.jpg' },
  { id: 'Pizza', labelBn: 'পিৎজা', labelEn: 'Pizza', img: '/src/assets/images/food_artisan_pizza_1794831375026.jpg' },
  { id: 'Burger', labelBn: 'বার্গার', labelEn: 'Burger', img: '/src/assets/images/food_gourmet_burger_1794831375029.jpg' },
  { id: 'Bangladeshi', labelBn: 'বাংলাদেশী', labelEn: 'Bangladeshi', img: '/src/assets/images/food_bangla_platter_1794831377030.jpg' },
  { id: 'Kabab', labelBn: 'কাবাব', labelEn: 'Kabab', img: '/src/assets/images/food_tandoori_kabab_1794831377175.jpg' },
  { id: 'Chinese', labelBn: 'চাইনিজ ও মোমো', labelEn: 'Chinese & Momos', img: '/src/assets/images/food_asian_momos_1794831375934.jpg' },
  { id: 'Bakery', labelBn: 'কেক ও বেকারি', labelEn: 'Bakery & Cakes', img: '/src/assets/images/food_cafe_dessert_1794831375892.jpg' },
  { id: 'Drinks', labelBn: 'কফি ও পানীয়', labelEn: 'Coffee & Drinks', img: '/src/assets/images/food_cafe_dessert_1794831375892.jpg' },
];
