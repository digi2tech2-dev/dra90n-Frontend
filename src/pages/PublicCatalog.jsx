import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Menu,
  ChevronRight,
  Layers3,
  Search,
  X,
  MessageCircle,
  ExternalLink,
  UserRound,
  CircleAlert,
  Info,
  Check,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import useAuthStore from '../store/useAuthStore';
import useMediaStore from '../store/useMediaStore';
import useGroupStore from '../store/useGroupStore';
import apiClient from '../services/client';
import ThemeToggle from '../components/ui/ThemeToggle';
import HeaderBrand from '../components/layout/HeaderBrand';
import PublicSidebar from '../components/layout/PublicSidebar';
import SiteCopyrightFooter from '../components/layout/SiteCopyrightFooter';
import HeroSlider from '../components/home/HeroSlider';
import CategoryCard from '../components/home/CategoryCard';
import BestSellingSection from '../components/home/BestSellingSection';
import ProductSearchBar from '../components/products/ProductSearchBar';
import ProductCardSimple from '../components/products/ProductCardSimple';
import ProductPurchaseDialog from '../components/products/ProductPurchaseDialog';
import LoadingSkeleton from '../components/products/LoadingSkeleton';
import EmptyState from '../components/products/EmptyState';
import Seo from '../components/seo/Seo';
import { getDefaultRouteForRole } from '../utils/authRoles';
import {
  createStorefrontCategories,
  createStorefrontProducts,
  getStorefrontLanguage,
} from '../utils/storefront';
import { buildStoreSeo, toAbsoluteUrl } from '../utils/seo';
import { useBodyScrollLock } from '../utils/bodyScrollLock';
import slideOneImage from '../assets/slide-1.jpg';
import slideTwoImage from '../assets/slide-2.jpg';
import slideThreeImage from '../assets/slide-3.jpg';
import slideFourImage from '../assets/slide-4.jpg';
import targetSalesImage from '../assets/تارجت.jpg';
import paymentWarningDragon from '../assets/payment-warning-dragon-lite.webp';

const dataProvider = (import.meta.env.VITE_DATA_PROVIDER || 'mock').toLowerCase();
const isRealProvider = dataProvider === 'real';
const WHATSAPP_CHANNEL_URL = 'https://whatsapp.com/channel/0029VbDau0q0G0XdNPUJjN1F';
const SLIDE_TWO_URL = 'https://whatsapp.com/channel/0029VbDau0q0G0XdNPUJjN1F';
const PUBLIC_NOTICES_SEEN_KEY = 'ka-card-public-notices-seen-v1';
const normalizeCategoryKey = (value) => String(value || '').trim().toLowerCase();

const addCategoryAlias = (set, value) => {
  const normalized = normalizeCategoryKey(value);
  if (normalized) {
    set.add(normalized);
  }
};

const hasSeenPublicNotices = () => {
  if (typeof window === 'undefined') return true;

  try {
    return window.localStorage.getItem(PUBLIC_NOTICES_SEEN_KEY) === 'true';
  } catch {
    return false;
  }
};

const markPublicNoticesSeen = () => {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(PUBLIC_NOTICES_SEEN_KEY, 'true');
  } catch {
    // Ignore storage restrictions; the notice should still work normally.
  }
};

const getGroupPercentage = (group) => {
  const value = Number(group?.percentage ?? group?.discount ?? group?.markup ?? group?.rate ?? 0);
  return Number.isFinite(value) ? value : 0;
};

const getPublicPricingGroup = (groups) => {
  const list = Array.isArray(groups) ? groups : [];
  const highestGroup = list.reduce((best, group) => {
    if (!best) return group;
    return getGroupPercentage(group) > getGroupPercentage(best) ? group : best;
  }, null);

  return {
    group: highestGroup?.name || highestGroup?.nameAr || 'Normal',
    groupId: highestGroup?.id || highestGroup?._id || highestGroup?.name || 'Normal',
    groupPercentage: highestGroup ? getGroupPercentage(highestGroup) : null,
    currency: 'USD',
    coins: 0,
    walletBalance: 0,
    creditLimit: 0,
    creditUsed: 0,
  };
};

const getProductCategoryKeys = (product) => {
  const keys = new Set();
  const category = product?.category;

  if (category && typeof category === 'object' && !Array.isArray(category)) {
    addCategoryAlias(keys, category._id);
    addCategoryAlias(keys, category.id);
    addCategoryAlias(keys, category.name);
    addCategoryAlias(keys, category.nameAr);
    addCategoryAlias(keys, category.title);
    addCategoryAlias(keys, category.titleAr);
    addCategoryAlias(keys, category.slug);
  } else {
    addCategoryAlias(keys, category);
  }

  addCategoryAlias(keys, product?.categoryId);
  addCategoryAlias(keys, product?.categoryName);
  addCategoryAlias(keys, product?.categoryNameAr);
  addCategoryAlias(keys, product?.categoryTitle);
  addCategoryAlias(keys, product?.categoryTitleAr);
  addCategoryAlias(keys, product?.categoryLabel);
  addCategoryAlias(keys, product?.categoryLabelAr);

  return keys;
};

const PublicCatalog = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { i18n } = useTranslation();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const userRole = useAuthStore((state) => state.user?.role);
  const loginWithGoogle = useAuthStore((state) => state.loginWithGoogle);
  const { categories, products, isLoading, loadProducts } = useMediaStore();
  const groups = useGroupStore((state) => state.groups);
  const loadGroups = useGroupStore((state) => state.loadGroups);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showServiceNotice, setShowServiceNotice] = useState(false);
  const [showWhatsAppNotice, setShowWhatsAppNotice] = useState(false);
  const [currentParentId, setCurrentParentId] = useState(null);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [publicCatalog, setPublicCatalog] = useState({ categories: null, products: null });
  const [isPublicCatalogLoading, setIsPublicCatalogLoading] = useState(isRealProvider);
  const hasActiveNotice = showServiceNotice || showWhatsAppNotice || isMenuOpen;

  useBodyScrollLock(hasActiveNotice);

  const language = getStorefrontLanguage(i18n);
  const isArabic = language === 'ar';
  const copy = useMemo(
    () => (
      isArabic
        ? {
            searchPlaceholder: 'ابحث عن منتج...',
            noResults: 'لا يوجد منتج مطابق',
            home: 'الرئيسية',
            emptyCatalogsTitle: 'لا توجد كاتلوجات جاهزة للعرض',
            emptyCatalogsDescription: 'عندما تتوفر أقسام مرتبطة بمنتجات ظاهرة في المتجر ستظهر هنا تلقائيًا.',
            emptyCategoryTitle: 'لا يوجد بها عناصر',
            emptyCategoryDescription: 'هذا القسم فارغ حاليًا، ويمكنك العودة لاختيار قسم آخر.',
            backToCatalogs: 'العودة إلى الأقسام',
            unavailable: 'غير متاح',
            loginToBuy: 'شراء الآن',
            targetTitle: 'بيع التارجت',
            topSellingTitle: 'الأكثر مبيعًا',
            viewAll: 'عرض الكل',
          }
        : {
            searchPlaceholder: 'Search for a product...',
            noResults: 'No matching product found',
            home: 'Home',
            emptyCatalogsTitle: 'No catalogs are ready to display',
            emptyCatalogsDescription: 'Collections linked to visible storefront products will appear here automatically.',
            emptyCategoryTitle: 'There are no items in this category',
            emptyCategoryDescription: 'This category is currently empty, and you can return to choose another one.',
            backToCatalogs: 'Back to categories',
            unavailable: 'Unavailable',
            loginToBuy: 'Buy now',
            targetTitle: 'Target Sales',
            topSellingTitle: 'Top selling',
            viewAll: 'View all',
          }
    ),
    [isArabic]
  );

  useEffect(() => {
    if (isAuthenticated) {
      navigate(getDefaultRouteForRole(userRole), { replace: true });
    }
  }, [isAuthenticated, navigate, userRole]);

  useEffect(() => {
    loadGroups({ force: false });
  }, [loadGroups]);

  useEffect(() => {
    if (typeof window === 'undefined' || isAuthenticated) return undefined;
    if (hasSeenPublicNotices()) return undefined;

    let didCancel = false;
    const showNotice = () => {
      if (!didCancel) {
        markPublicNoticesSeen();
        setShowServiceNotice(true);
      }
    };

    const scheduleNotice = () => {
      if ('requestIdleCallback' in window) {
        return window.requestIdleCallback(showNotice, { timeout: 1800 });
      }

      return window.setTimeout(showNotice, 900);
    };

    const handle = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(scheduleNotice);
    });

    return () => {
      didCancel = true;
      window.cancelAnimationFrame(handle);
    };
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isRealProvider) {
      void loadProducts({ force: true, bypassCache: true });
      setIsPublicCatalogLoading(false);
      return undefined;
    }

    let isMounted = true;
    let refreshRequest = null;

    const refreshCatalog = ({ showLoading = false } = {}) => {
      if (refreshRequest) return refreshRequest;
      if (showLoading) setIsPublicCatalogLoading(true);

      refreshRequest = Promise.resolve(apiClient.publicCatalog.fetch())
        .then((catalog) => {
          if (!isMounted || !catalog) return;

          const nextCategories = Array.isArray(catalog.categories) ? catalog.categories : null;
          const nextProducts = Array.isArray(catalog.products) ? catalog.products : null;

          if (nextCategories || nextProducts) {
            setPublicCatalog({
              categories: nextCategories,
              products: nextProducts,
            });
          }
        })
        .catch(() => {
          if (isMounted) setPublicCatalog({ categories: null, products: null });
          return loadProducts({ force: true, bypassCache: true });
        })
        .finally(() => {
          refreshRequest = null;
          if (isMounted && showLoading) setIsPublicCatalogLoading(false);
        });

      return refreshRequest;
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refreshCatalog();
    };

    void refreshCatalog({ showLoading: true });
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    const refreshInterval = window.setInterval(refreshWhenVisible, 30_000);

    return () => {
      isMounted = false;
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.clearInterval(refreshInterval);
    };
  }, [loadProducts]);

  const handleCloseServiceNotice = useCallback(() => {
    setShowServiceNotice(false);
    setShowWhatsAppNotice(true);
  }, []);

  const handleCloseWhatsAppNotice = useCallback(() => {
    markPublicNoticesSeen();
    setShowWhatsAppNotice(false);
  }, []);

  const heroSlides = useMemo(
    () => ([
      { id: 'landing-slide-1', image: slideOneImage, title: '' },
      { id: 'landing-slide-2', image: slideTwoImage, title: '', href: SLIDE_TWO_URL },
      { id: 'landing-slide-3', image: slideThreeImage, title: '', href: '/referral' },
      { id: 'landing-slide-4', image: slideFourImage, title: '' },
    ]),
    []
  );

  const catalogProducts = useMemo(
    // Use one authoritative availability source. Mixing two responses can let a
    // stale `active` snapshot overwrite a freshly stopped product.
    () => (Array.isArray(publicCatalog.products) ? publicCatalog.products : products),
    [products, publicCatalog.products]
  );
  const catalogCategories = useMemo(
    () => (Array.isArray(publicCatalog.categories) ? publicCatalog.categories : categories),
    [categories, publicCatalog.categories]
  );
  const publicPricingUser = useMemo(() => getPublicPricingGroup(groups), [groups]);

  const storefrontProducts = useMemo(
    () => createStorefrontProducts(catalogProducts, {
      language,
      userGroup: publicPricingUser.groupId || publicPricingUser.group,
      userGroupPercentage: publicPricingUser.groupPercentage,
    }),
    [catalogProducts, language, publicPricingUser.group, publicPricingUser.groupId, publicPricingUser.groupPercentage]
  );

  const storefrontCategories = useMemo(
    () => createStorefrontCategories(catalogCategories, storefrontProducts, language)
      .filter((category) => category.id !== 'all'),
    [catalogCategories, storefrontProducts, language]
  );

  const sourceCategoriesById = useMemo(() => {
    const map = new Map();

    (Array.isArray(catalogCategories) ? catalogCategories : []).forEach((category) => {
      const id = String(category?.id || category?._id || '').trim();
      if (id) {
        map.set(id, category);
      }
    });

    return map;
  }, [catalogCategories]);

  const categoryAliasesById = useMemo(() => {
    const map = new Map();

    storefrontCategories.forEach((category) => {
      const aliases = new Set();
      const sourceCategory = sourceCategoriesById.get(category.id) || {};

      addCategoryAlias(aliases, category.id);
      addCategoryAlias(aliases, category.title);
      addCategoryAlias(aliases, sourceCategory.id);
      addCategoryAlias(aliases, sourceCategory._id);
      addCategoryAlias(aliases, sourceCategory.name);
      addCategoryAlias(aliases, sourceCategory.nameAr);
      addCategoryAlias(aliases, sourceCategory.title);
      addCategoryAlias(aliases, sourceCategory.titleAr);
      addCategoryAlias(aliases, sourceCategory.slug);

      map.set(category.id, aliases);
    });

    return map;
  }, [sourceCategoriesById, storefrontCategories]);

  const getParentId = useCallback((category) => {
    if (!category || !category.parentCategory) return null;

    const parent = category.parentCategory;
    if (typeof parent === 'object') return parent._id || parent.id || String(parent) || null;
    if (typeof parent === 'string') {
      const trimmed = parent.trim();
      return trimmed || null;
    }

    return String(parent) || null;
  }, []);

  const childrenMap = useMemo(() => {
    const map = new Map();

    for (const category of storefrontCategories) {
      const parentId = getParentId(category);
      if (!map.has(parentId)) {
        map.set(parentId, []);
      }
      map.get(parentId).push(category);
    }

    return map;
  }, [getParentId, storefrontCategories]);

  const currentCategories = useMemo(
    () => storefrontCategories.filter((category) => {
      const parentId = getParentId(category);
      if (currentParentId === null) return parentId === null;
      return String(parentId || '').trim() === String(currentParentId || '').trim();
    }),
    [currentParentId, getParentId, storefrontCategories]
  );

  const breadcrumbTrail = useMemo(() => {
    if (!currentParentId) return [];

    const categoriesById = new Map(storefrontCategories.map((category) => [category.id, category]));
    const trail = [];
    let categoryId = currentParentId;

    while (categoryId) {
      const category = categoriesById.get(categoryId);
      if (!category) break;
      trail.unshift(category);
      categoryId = getParentId(category);
    }

    return trail;
  }, [currentParentId, getParentId, storefrontCategories]);

  const currentCategoryIds = useMemo(() => {
    if (!currentParentId) return [];

    const ids = [];
    const seen = new Set();
    const queue = [currentParentId];

    while (queue.length > 0) {
      const categoryId = queue.shift();
      if (!categoryId || seen.has(categoryId)) continue;

      seen.add(categoryId);
      ids.push(categoryId);

      (childrenMap.get(categoryId) || []).forEach((child) => {
        if (child?.id && !seen.has(child.id)) {
          queue.push(child.id);
        }
      });
    }

    return ids;
  }, [childrenMap, currentParentId]);

  const currentCategoryProductKeys = useMemo(() => {
    const keys = new Set();

    currentCategoryIds.forEach((categoryId) => {
      const aliases = categoryAliasesById.get(categoryId);
      if (aliases) {
        aliases.forEach((alias) => keys.add(alias));
      } else {
        addCategoryAlias(keys, categoryId);
      }
    });

    return keys;
  }, [categoryAliasesById, currentCategoryIds]);

  const currentProducts = useMemo(
    () => (
      currentParentId
        ? storefrontProducts.filter((product) => {
          const productCategoryKeys = getProductCategoryKeys(product);
          return Array.from(productCategoryKeys).some((key) => currentCategoryProductKeys.has(key));
        })
        : []
    ),
    [currentCategoryProductKeys, currentParentId, storefrontProducts]
  );

  const homepageProducts = useMemo(() => {
    const rootCategories = storefrontCategories.filter((category) => {
      const parentId = getParentId(category);
      return parentId === null;
    });
    const pickedIds = new Set();

    const pickFromCategory = (category, limit) => {
      if (!category) return [];
      const categoryIds = new Set([category.id]);
      const queue = [category.id];
      const selected = [];

      while (queue.length > 0) {
        const categoryId = queue.shift();
        (childrenMap.get(categoryId) || []).forEach((child) => {
          if (child?.id && !categoryIds.has(child.id)) {
            categoryIds.add(child.id);
            queue.push(child.id);
          }
        });
      }

      const categoryKeys = new Set();
      categoryIds.forEach((categoryId) => {
        addCategoryAlias(categoryKeys, categoryId);
        const aliases = categoryAliasesById.get(categoryId);
        if (aliases) {
          aliases.forEach((alias) => categoryKeys.add(alias));
        }
      });

      for (const product of storefrontProducts) {
        if (selected.length >= limit) break;
        const productCategoryKeys = getProductCategoryKeys(product);
        const matchesCategory = Array.from(productCategoryKeys).some((key) => categoryKeys.has(key));
        if (!matchesCategory) continue;
        if (pickedIds.has(product.id)) continue;
        pickedIds.add(product.id);
        selected.push(product);
      }

      return selected;
    };

    return [
      ...pickFromCategory(rootCategories[0], 4),
      ...pickFromCategory(rootCategories[1], 4),
    ];
  }, [categoryAliasesById, childrenMap, getParentId, storefrontCategories, storefrontProducts]);

  const showInitialLoading = (isRealProvider ? isPublicCatalogLoading : isLoading)
    && storefrontProducts.length === 0
    && storefrontCategories.length === 0;
  const isInsideCategory = Boolean(currentParentId);
  const shouldMergeProductsWithSubcategories =
    isInsideCategory && currentCategories.length > 0;

  const seoData = useMemo(
    () => buildStoreSeo({
      products: storefrontProducts,
      categories: storefrontCategories,
      language,
      path: `${location.pathname}${location.search || ''}`,
    }),
    [language, location.pathname, location.search, storefrontCategories, storefrontProducts]
  );

  const seoImage = useMemo(
    () => toAbsoluteUrl(storefrontProducts.find((product) => product?.image)?.image || '/dra90n-og.webp?v=dra90n-store'),
    [storefrontProducts]
  );

  const selectedCategoryExists = useMemo(
    () => !currentParentId || storefrontCategories.some((category) => category.id === currentParentId),
    [currentParentId, storefrontCategories]
  );

  useEffect(() => {
    if (selectedCategoryExists) return;
    setCurrentParentId(null);
  }, [selectedCategoryExists]);

  const handleCategorySelect = useCallback((categoryId) => {
    setCurrentParentId(categoryId || null);
  }, []);

  const handleProductSelect = useCallback((product) => {
    if (!product) return;
    setSelectedProduct(product);
  }, []);

  const closePurchaseDialog = useCallback(() => {
    setSelectedProduct(null);
  }, []);

  const resetToCatalogs = useCallback(() => {
    setCurrentParentId(null);
  }, []);

  const navigateBreadcrumb = useCallback((categoryId) => {
    setCurrentParentId(categoryId || null);
  }, []);

  const handleLogin = useCallback(() => {
    navigate('/auth?mode=login');
  }, [navigate]);

  const handleCreateAccount = useCallback(() => {
    navigate('/auth?mode=signup');
  }, [navigate]);

  const handleGoogleLogin = useCallback(() => {
    Promise.resolve(loginWithGoogle());
  }, [loginWithGoogle]);

  const handleAbout = useCallback(() => {
    navigate('/about-us');
  }, [navigate]);

  const handleContact = useCallback(() => {
    navigate('/public-contact-us');
  }, [navigate]);

  const handleHome = useCallback(() => {
    navigate('/');
  }, [navigate]);

  if (isAuthenticated) return null;

  return (
    <div className="min-h-screen pb-5 pt-[4.75rem]">
      <Seo
        title={seoData.title}
        description={seoData.description}
        keywords={seoData.keywords}
        canonicalUrl={seoData.canonicalUrl}
        image={seoImage}
        language={language}
        jsonLd={seoData.jsonLd}
      />

      {typeof document !== 'undefined' && createPortal(
      <header className="pointer-events-none fixed inset-x-0 top-0 z-[90]">
        <div className="mx-auto max-w-[var(--shell-max-width)] px-3 py-2 sm:px-4 lg:px-6">
          <div dir="ltr" className="ka-card-panel pointer-events-auto grid min-h-[2.95rem] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 rounded-[20px] border px-2.5 py-1 sm:min-h-[3.25rem] sm:gap-5 sm:rounded-[28px] sm:px-5 sm:py-1.5">
            <div className="col-start-1 row-start-1 flex items-center gap-1 justify-self-start sm:gap-2">
              <ThemeToggle variant="glass" compact className="h-9 w-9 sm:h-10 sm:w-10" />
            </div>

            <div className="col-start-2 row-start-1 justify-self-center">
              <HeaderBrand />
            </div>

            <div className="col-start-3 row-start-1 flex items-center gap-1.5 justify-self-end sm:gap-2">
              <button
                type="button"
                onClick={handleLogin}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-orange-200/20 bg-[linear-gradient(180deg,rgb(36_17_8/0.9),rgb(5_3_2/0.84))] text-orange-50 shadow-[inset_0_0_18px_rgb(255_255_255/0.035),0_0_26px_-18px_rgb(245_158_11/0.9)] transition-all hover:-translate-y-0.5 hover:border-amber-200/30 hover:text-amber-100 sm:h-10 sm:w-10"
                aria-label={isArabic ? 'تسجيل الدخول' : 'Login'}
              >
                <UserRound className="h-4.5 w-4.5 sm:h-5 sm:w-5" />
              </button>

              <button
                type="button"
                onClick={() => setIsMenuOpen((previous) => !previous)}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[color:rgb(var(--color-border-rgb)/0.84)] bg-[linear-gradient(180deg,rgb(3_8_22/0.9),rgb(2_6_19/0.78))] text-[var(--color-text)] shadow-[inset_0_0_18px_rgb(255_255_255/0.035),0_0_26px_-18px_rgb(34_211_238/0.9)] transition-all hover:-translate-y-0.5 hover:border-[color:rgb(var(--color-primary-rgb)/0.38)] hover:text-[var(--color-primary)] sm:h-10 sm:w-10"
                aria-label={isArabic ? 'القائمة' : 'Menu'}
              >
                <Menu className="h-4.5 w-4.5 sm:h-6 sm:w-6" />
              </button>
            </div>
          </div>
        </div>
      </header>,
      document.body
      )}

      <PublicSidebar
        isOpen={isMenuOpen}
        onClose={() => setIsMenuOpen(false)}
        onHome={handleHome}
        onAbout={handleAbout}
        onContact={handleContact}
        onLogin={handleLogin}
        onCreateAccount={handleCreateAccount}
        onGoogleLogin={handleGoogleLogin}
        isBusy={false}
        isArabic={isArabic}
      />

      {typeof document !== 'undefined' && createPortal(
        <>
      {showServiceNotice && (
        <div className="public-notice-overlay public-notice-overlay--service fixed inset-0 z-[90] flex items-center justify-center bg-[radial-gradient(circle_at_50%_15%,rgb(168_85_247/0.24),rgb(15_23_42/0.72)_48%,rgb(0_0_0/0.92))] px-4 backdrop-blur-md">
          <div
            dir="rtl"
            className="public-notice-card public-notice-card--service service-notice-card ka-card-panel relative w-full max-w-[19.5rem] overflow-hidden rounded-[1.5rem] border border-orange-200/20 text-right shadow-[0_30px_86px_-46px_rgb(168_23_19/0.95)] backdrop-blur-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="service-notice-title"
            style={{ animation: 'page-fade-in 180ms ease-out both' }}
          >
            <div className="pointer-events-none absolute inset-x-10 top-0 h-px bg-[linear-gradient(90deg,transparent,#c084fc,#f472b6,#c084fc,transparent)]" />
            <div className="pointer-events-none absolute -top-20 left-1/2 h-40 w-64 -translate-x-1/2 rounded-full bg-[color:rgb(168_23_19/0.2)] blur-3xl" />

            <button
              type="button"
              onClick={handleCloseServiceNotice}
              className="service-notice-close absolute left-3 top-3 z-20 inline-flex h-8 w-8 items-center justify-center rounded-full border border-[color:rgb(var(--color-border-rgb)/0.65)] bg-[color:rgb(var(--color-card-rgb)/0.72)] text-[var(--color-text-secondary)] shadow-sm transition-all hover:rotate-90 hover:border-[color:rgb(var(--color-primary-rgb)/0.35)] hover:text-[var(--color-primary)]"
              aria-label={isArabic ? 'إغلاق التنويه' : 'Close notice'}
            >
              <X className="h-4 w-4" />
            </button>

            <div className="relative px-4 pb-4 pt-3.5">
              <div dir="ltr" className="flex h-8 justify-center pl-7">
                <HeaderBrand
                  className="origin-top scale-[0.58] justify-center"
                  iconClassName="scale-[0.72]"
                  textClassName="text-center"
                />
              </div>

              <div className="service-notice-dragon-visual" aria-hidden="true">
                <span className="service-notice-fire-glow" />
                <span className="service-notice-fire-embers" />
                <img
                  src={paymentWarningDragon}
                  alt=""
                  className="service-notice-dragon-art"
                  loading="eager"
                  decoding="async"
                  fetchPriority="high"
                />
              </div>

              <div className="service-notice-title-block mb-3 -mt-1 text-center">
                <span className="mx-auto grid h-9 w-9 place-items-center rounded-xl border border-amber-300/30 bg-amber-400/10 text-amber-300 shadow-[0_12px_28px_-20px_rgb(245_158_11/0.9)]">
                  <CircleAlert className="h-5.5 w-5.5" strokeWidth={2.1} />
                </span>
                <h2 id="service-notice-title" className="service-notice-title mt-2 text-lg font-black text-[var(--color-text)]">
                  تنبيه قبل الدفع
                </h2>
              </div>

              <div className="space-y-2">
                <div className="flex gap-2.5 rounded-2xl border border-amber-300/15 bg-[linear-gradient(135deg,rgb(245_158_11/0.1),rgb(var(--color-surface-rgb)/0.44))] p-3">
                  <span className="public-notice-dot public-notice-dot--warning grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-amber-400/15 text-amber-400">
                    <CircleAlert className="h-3.5 w-3.5" />
                  </span>
                  <p className="public-notice-text text-[0.76rem] font-extrabold leading-5 text-[var(--color-text)]">
                    المنتجات الرقمية لا تُسترد بعد تأكيد التحويل.
                  </p>
                </div>

                <div className="flex gap-2.5 rounded-2xl border border-orange-300/15 bg-[linear-gradient(135deg,rgb(168_23_19/0.1),rgb(var(--color-surface-rgb)/0.44))] p-3">
                  <span className="public-notice-dot public-notice-dot--info grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-orange-400/15 text-orange-400">
                    <Info className="h-3.5 w-3.5" />
                  </span>
                  <p className="public-notice-muted text-[0.75rem] font-bold leading-5 text-[var(--color-text-secondary)]">
                    راجع تفاصيل طلبك جيدًا قبل الدفع.
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={handleCloseServiceNotice}
                className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-orange-200/20 bg-[linear-gradient(135deg,#a81713,#c2410c_52%,#ffb52e)] px-4 text-[0.82rem] font-black text-[#1b0903] shadow-[0_16px_36px_-22px_rgb(168_23_19/0.95)] transition-all hover:-translate-y-0.5 hover:brightness-110"
              >
                <Check className="h-4 w-4" strokeWidth={2.5} />
                متابعة
              </button>
            </div>
          </div>
        </div>
      )}

      {showWhatsAppNotice && (
        <div className="public-notice-overlay public-notice-overlay--whatsapp fixed inset-0 z-[90] flex items-center justify-center bg-[radial-gradient(circle_at_50%_15%,rgb(168_85_247/0.24),rgb(15_23_42/0.72)_48%,rgb(0_0_0/0.92))] px-4 backdrop-blur-md">
          <div
            dir="rtl"
            className="public-notice-card public-notice-card--whatsapp service-notice-card community-notice-card ka-card-panel relative w-full max-w-[19.5rem] overflow-hidden rounded-[1.5rem] border border-orange-200/20 text-right shadow-[0_30px_86px_-46px_rgb(168_23_19/0.95)] backdrop-blur-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="whatsapp-notice-title"
            style={{ animation: 'page-fade-in 180ms ease-out both' }}
          >
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,#a81713,#f97316,#ffb52e,transparent)]" />
            <div className="pointer-events-none absolute -top-16 left-1/2 h-24 w-44 -translate-x-1/2 rounded-full bg-[color:rgb(37_211_102/0.16)] blur-3xl" />

            <button
              type="button"
              onClick={handleCloseWhatsAppNotice}
              className="service-notice-close absolute left-3 top-3 z-20 inline-flex h-8 w-8 items-center justify-center rounded-full border border-[color:rgb(var(--color-border-rgb)/0.65)] bg-[color:rgb(var(--color-card-rgb)/0.72)] text-[var(--color-text-secondary)] shadow-sm transition-all hover:rotate-90 hover:border-[color:rgb(var(--color-primary-rgb)/0.35)] hover:text-[var(--color-primary)]"
              aria-label={isArabic ? 'إغلاق تنويه المجتمع' : 'Close community notice'}
            >
              <X className="h-4 w-4" />
            </button>

            <div className="relative px-4 pb-4 pt-3.5">
              <div dir="ltr" className="flex h-8 justify-center pl-7">
                <HeaderBrand
                  className="origin-top scale-[0.58] justify-center"
                  iconClassName="scale-[0.72]"
                  textClassName="text-center"
                />
              </div>

              <div className="service-notice-dragon-visual" aria-hidden="true">
                <span className="service-notice-fire-glow" />
                <span className="service-notice-fire-embers" />
                <img
                  src={paymentWarningDragon}
                  alt=""
                  className="service-notice-dragon-art"
                  loading="eager"
                  decoding="async"
                  fetchPriority="high"
                />
              </div>

              <div className="service-notice-title-block mb-3 -mt-1 text-center">
                <span className="mx-auto grid h-9 w-9 place-items-center rounded-xl border border-amber-300/30 bg-amber-400/10 text-amber-300 shadow-[0_12px_28px_-20px_rgb(245_158_11/0.9)]">
                  <MessageCircle className="h-5 w-5" strokeWidth={2.1} />
                </span>
                <h2 id="whatsapp-notice-title" className="service-notice-title mt-2 text-lg font-black leading-6 text-[var(--color-text)]">
                  تنويه المجتمع
                </h2>
              </div>

              <div className="public-notice-body space-y-2 rounded-2xl border border-amber-300/15 bg-[linear-gradient(135deg,rgb(245_158_11/0.1),rgb(var(--color-surface-rgb)/0.44))] p-3">
                <div className="flex gap-2.5 rounded-xl border border-amber-300/10 bg-[rgb(14_7_4/0.22)] p-2.5">
                  <span className="public-notice-dot public-notice-dot--success grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-amber-400/15 text-amber-300">
                    <MessageCircle className="h-3.5 w-3.5" />
                  </span>
                  <p className="public-notice-text text-[0.76rem] font-extrabold leading-5 text-[var(--color-text)]">
                    عدم متابعتك لمجتمع الواتساب مسؤوليتك الشخصية
                  </p>
                </div>

                <div className="flex gap-2.5 rounded-xl border border-orange-300/10 bg-[rgb(14_7_4/0.2)] p-2.5">
                  <span className="public-notice-dot public-notice-dot--info grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-orange-400/15 text-[0.68rem] font-black text-orange-300">
                    i
                  </span>
                  <p className="public-notice-muted text-[0.75rem] font-bold leading-5 text-[var(--color-text-secondary)]">
                    واي اهمال في المتابعة تعرضك للمخاطر دون اي مسؤولية علينا
                  </p>
                </div>
              </div>

              <a
                href={WHATSAPP_CHANNEL_URL}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-orange-200/20 bg-[linear-gradient(135deg,#a81713,#c2410c_52%,#ffb52e)] px-4 text-[0.82rem] font-black text-[#1b0903] shadow-[0_16px_36px_-22px_rgb(168_23_19/0.95)] transition-all hover:-translate-y-0.5 hover:brightness-110"
              >
                <MessageCircle className="h-4 w-4" />
                مجتمع الواتساب
                <ExternalLink className="h-3.5 w-3.5" />
              </a>

              <button
                type="button"
                onClick={handleCloseWhatsAppNotice}
                className="public-notice-secondary-button mt-2 inline-flex h-10 w-full items-center justify-center rounded-xl border border-orange-200/25 bg-[rgb(40_18_8/0.76)] px-4 text-[0.82rem] font-black text-orange-50 shadow-[0_16px_34px_-26px_rgb(168_23_19/0.9)] transition-all hover:-translate-y-0.5 hover:border-orange-300/30 hover:text-orange-100"
              >
                موافق
              </button>
            </div>
          </div>
        </div>
      )}
        </>,
        document.body
      )}

      <main className="px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <div className="mx-auto max-w-[var(--shell-max-width)] space-y-5 sm:space-y-6">
          <section aria-label={isArabic ? 'العروض الرئيسية' : 'Featured offers'}>
            <HeroSlider slides={heroSlides} />
          </section>

          <section id="categories" className="scroll-mt-28 space-y-3 sm:space-y-3.5">
            <div className="relative z-10 mx-auto flex w-full max-w-5xl justify-center px-0.5 sm:px-2">
              <ProductSearchBar
                products={storefrontProducts}
                language={language}
                onSelectProduct={handleProductSelect}
                forceIconRight
                placeholder={copy.searchPlaceholder}
                noResultsLabel={copy.noResults}
                className="mx-auto w-full"
                inputClassName="h-12 rounded-full"
              />
            </div>

            {showInitialLoading && (
              <LoadingSkeleton variant="catalogs" />
            )}

            {!showInitialLoading && isInsideCategory && (
              <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-1 px-1 text-sm">
                <button
                  type="button"
                  onClick={resetToCatalogs}
                  className="font-medium text-[var(--color-primary)] hover:underline"
                >
                  {copy.home}
                </button>
                {breadcrumbTrail.map((category) => (
                  <span key={category.id} className="flex items-center gap-1">
                    <ChevronRight className="h-3.5 w-3.5 text-[var(--color-text-secondary)]" />
                    <button
                      type="button"
                      onClick={() => navigateBreadcrumb(category.id)}
                      className="text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-primary)] hover:underline"
                    >
                      {category.title}
                    </button>
                  </span>
                ))}
              </nav>
            )}

            {!showInitialLoading && (
              <>
                {!isInsideCategory && currentCategories.length > 0 && (
                  <div className="relative z-0 grid grid-cols-2 gap-2 sm:gap-2.5 md:grid-cols-3 xl:grid-cols-4">
                    {currentCategories.map((category, index) => (
                      <CategoryCard
                        key={category.id}
                        category={category}
                        active={false}
                        index={index}
                        onSelect={handleCategorySelect}
                      />
                    ))}
                  </div>
                )}

                {shouldMergeProductsWithSubcategories && (
                  <div className="grid grid-cols-3 gap-3 p-1 sm:gap-4">
                    {currentCategories.map((category, index) => (
                      <CategoryCard
                        key={category.id}
                        category={category}
                        active={false}
                        index={index}
                        onSelect={handleCategorySelect}
                        variant="product"
                      />
                    ))}
                    {currentCategories.length === 0 && currentProducts.map((product) => (
                      <ProductCardSimple
                        key={product.id}
                        product={product}
                        onOpen={handleProductSelect}
                        buyLabel={copy.loginToBuy}
                        unavailableLabel={copy.unavailable}
                      />
                    ))}
                  </div>
                )}

                {isInsideCategory && currentProducts.length > 0 && !shouldMergeProductsWithSubcategories && (
                  <div className="grid grid-cols-3 gap-3 p-1 sm:gap-4">
                    {currentProducts.map((product) => (
                      <ProductCardSimple
                        key={product.id}
                        product={product}
                        onOpen={handleProductSelect}
                        buyLabel={copy.loginToBuy}
                        unavailableLabel={copy.unavailable}
                      />
                    ))}
                  </div>
                )}

                {isInsideCategory && currentCategories.length === 0 && currentProducts.length === 0 && (
                  <EmptyState
                    icon={Layers3}
                    title={copy.emptyCategoryTitle}
                    description={copy.emptyCategoryDescription}
                    actionLabel={copy.backToCatalogs}
                    onAction={resetToCatalogs}
                  />
                )}

                {!isInsideCategory && currentCategories.length === 0 && (
                  <EmptyState
                    icon={Search}
                    title={copy.emptyCatalogsTitle}
                    description={copy.emptyCatalogsDescription}
                  />
                )}
              </>
            )}
          </section>

          {!isInsideCategory && (
            <div className="mx-auto w-full max-w-5xl px-0.5 sm:px-2">
              <button
                type="button"
                onClick={handleLogin}
                className="group mx-auto block w-full max-w-5xl overflow-hidden rounded-[1rem] border border-[color:rgb(var(--color-primary-rgb)/0.28)] bg-[color:rgb(var(--color-card-rgb)/0.76)] text-start shadow-[0_18px_42px_-30px_rgb(var(--color-primary-rgb)/0.82),inset_0_1px_0_rgb(255_255_255/0.08)] backdrop-blur-xl transition-all duration-300 hover:-translate-y-0.5 hover:border-[color:rgb(var(--color-primary-rgb)/0.46)] hover:shadow-[0_22px_48px_-30px_rgb(var(--color-primary-rgb)/0.9)]"
                aria-label={copy.targetTitle}
              >
                <span className="block overflow-hidden bg-black">
                  <img
                    src={targetSalesImage}
                    alt={copy.targetTitle}
                    className="block aspect-[2112/745] w-full object-contain transition-transform duration-500 group-hover:scale-[1.012]"
                    loading="lazy"
                    decoding="async"
                  />
                </span>
                <span className="block border-t border-[color:rgb(var(--color-primary-rgb)/0.18)] bg-[linear-gradient(180deg,rgb(var(--color-card-rgb)/0.94),rgb(var(--color-primary-rgb)/0.08))] px-3 py-1.5 text-center">
                  <span className="text-xs font-extrabold text-[var(--color-text)] sm:text-sm">
                    {copy.targetTitle}
                  </span>
                </span>
              </button>
            </div>
          )}

          {!isInsideCategory && homepageProducts.length ? (
            <BestSellingSection
              id="public-best-selling-title"
              title={copy.topSellingTitle}
              viewAllLabel={copy.viewAll}
              products={homepageProducts}
              categories={storefrontCategories}
              language={language}
              onViewAll={handleLogin}
              onProductSelect={handleProductSelect}
            />
          ) : null}
        </div>
      </main>

      <ProductPurchaseDialog
        isOpen={Boolean(selectedProduct)}
        productId={selectedProduct?.id}
        initialProduct={selectedProduct}
        onClose={closePurchaseDialog}
        pricingPreviewUser={publicPricingUser}
        requireAuth
        onRequireAuth={handleLogin}
      />

      <SiteCopyrightFooter isArabic={isArabic} />
    </div>
  );
};

export default PublicCatalog;
