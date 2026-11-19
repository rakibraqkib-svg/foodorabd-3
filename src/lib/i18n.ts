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

export const DHAKA_AREAS = [
  { name: 'Gulshan 2', nameBn: 'গুলশান ২', lat: 23.7949, lng: 90.4144 },
  { name: 'Banani', nameBn: 'বনানী', lat: 23.7937, lng: 90.4066 },
  { name: 'Dhanmondi 27', nameBn: 'ধানমন্ডি ২৭', lat: 23.7518, lng: 90.3712 },
  { name: 'Gulshan 1', nameBn: 'গুলশান ১', lat: 23.7811, lng: 90.4167 },
  { name: 'Uttara Sector 7', nameBn: 'উত্তরা সেক্টর ৭', lat: 23.8682, lng: 90.3991 },
  { name: 'Mirpur 10', nameBn: 'মিরপুর ১০', lat: 23.8069, lng: 90.3687 },
  { name: 'Bashundhara R/A', nameBn: 'বসুন্ধরা আবাসিক এলাকা', lat: 23.8191, lng: 90.4526 },
  { name: 'Motijheel', nameBn: 'মতিঝিল', lat: 23.7272, lng: 90.4198 },
];

export interface BangladeshAreaPreset {
  name: string;
  nameBn: string;
  division: string;
  lat: number;
  lng: number;
}

export const BANGLADESH_AREAS: BangladeshAreaPreset[] = [
  { name: 'Gulshan 2', nameBn: 'গুলশান ২, ঢাকা', division: 'Dhaka', lat: 23.7949, lng: 90.4144 },
  { name: 'Banani', nameBn: 'বনানী, ঢাকা', division: 'Dhaka', lat: 23.7937, lng: 90.4066 },
  { name: 'Dhanmondi 27', nameBn: 'ধানমন্ডি ২৭, ঢাকা', division: 'Dhaka', lat: 23.7518, lng: 90.3712 },
  { name: 'Gulshan 1', nameBn: 'গুলশান ১, ঢাকা', division: 'Dhaka', lat: 23.7811, lng: 90.4167 },
  { name: 'Uttara Sector 7', nameBn: 'উত্তরা, ঢাকা', division: 'Dhaka', lat: 23.8682, lng: 90.3991 },
  { name: 'Mirpur 10', nameBn: 'মিরপুর ১০, ঢাকা', division: 'Dhaka', lat: 23.8069, lng: 90.3687 },
  { name: 'Bashundhara R/A', nameBn: 'বসুন্ধরা, ঢাকা', division: 'Dhaka', lat: 23.8191, lng: 90.4526 },
  { name: 'Motijheel', nameBn: 'মতিঝিল, ঢাকা', division: 'Dhaka', lat: 23.7272, lng: 90.4198 },
  { name: 'Chattogram (GEC / Agrabad)', nameBn: 'চট্টগ্রাম (জিইসি / আগ্রাবাদ)', division: 'Chattogram', lat: 22.3569, lng: 91.7832 },
  { name: 'Sylhet (Zindabazar)', nameBn: 'সিলেট (জিন্দাবাজার)', division: 'Sylhet', lat: 24.8949, lng: 91.8687 },
  { name: 'Rajshahi (Shaheb Bazar)', nameBn: 'রাজশাহী (সাহেব বাজার)', division: 'Rajshahi', lat: 24.3745, lng: 88.6042 },
  { name: 'Khulna (Shib Bari)', nameBn: 'খুলনা (শিববাড়ী)', division: 'Khulna', lat: 22.8456, lng: 89.5403 },
  { name: 'Barishal (Sadar)', nameBn: 'বরিশাল (সদর)', division: 'Barishal', lat: 22.701, lng: 90.3535 },
  { name: 'Rangpur (Jahaj Company)', nameBn: 'রংপুর (জাহাজ কোম্পানি)', division: 'Rangpur', lat: 25.7439, lng: 89.2752 },
  { name: 'Mymensingh (Town Hall)', nameBn: 'ময়মনসিংহ (টাউন হল)', division: 'Mymensingh', lat: 24.7471, lng: 90.4203 },
  { name: 'Narayanganj (Chashara)', nameBn: 'নারায়ণগঞ্জ (চাষাঢ়া)', division: 'Dhaka', lat: 23.6238, lng: 90.5 },
  { name: 'Gazipur (Joydebpur)', nameBn: 'গাজীপুর (জয়দেবপুর)', division: 'Dhaka', lat: 23.9999, lng: 90.4203 },
  { name: 'Savar (City Center)', nameBn: 'সাভার (সিটি সেন্টার)', division: 'Dhaka', lat: 23.8583, lng: 90.2667 },
  { name: 'Cumilla (Kandirpar)', nameBn: 'কুমিল্লা (কান্দিরপাড়)', division: 'Chattogram', lat: 23.4607, lng: 91.1809 },
  { name: "Cox's Bazar (Kolatoli)", nameBn: 'কক্সবাজার (কলাতলী)', division: 'Chattogram', lat: 21.4272, lng: 92.0058 },
  { name: 'Bogura (Satmatha)', nameBn: 'বগুড়া (সাতমাথা)', division: 'Rajshahi', lat: 24.8481, lng: 89.373 },
  { name: 'Jashore (Town)', nameBn: 'যশোর (শহর)', division: 'Khulna', lat: 23.1664, lng: 89.2081 },
];

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
