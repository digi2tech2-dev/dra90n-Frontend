import React, { startTransition, useCallback, useEffect, useMemo, useState } from 'react';
import { Layers3, Search, ChevronRight, ArrowLeft, ArrowRight } from 'lucide-react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import useAuthStore from '../store/useAuthStore';
import useMediaStore from '../store/useMediaStore';
import useGroupStore from '../store/useGroupStore';
import useSystemStore from '../store/useSystemStore';
import ProductSearchBar from '../components/products/ProductSearchBar';
import HeroSlider from '../components/home/HeroSlider';
import CategoryCard from '../components/home/CategoryCard';
import ProductCardSimple from '../components/products/ProductCardSimple';
import ProductPurchaseDialog from '../components/products/ProductPurchaseDialog';
import LoadingSkeleton from '../components/products/LoadingSkeleton';
import EmptyState from '../components/products/EmptyState';
import Seo from '../components/seo/Seo';
import {
  createStorefrontCategories,
  createStorefrontProducts,
  getStorefrontLanguage,
} from '../utils/storefront';
import { buildStoreSeo, toAbsoluteUrl } from '../utils/seo';
import slideFourImage from '../assets/slide-4.jpg';
import slideThreeImage from '../assets/slide-3.jpg';

const getProductsPageCopy = (language = 'ar') => (
  language === 'ar'
    ? {
        pageKicker: 'Premium Storefront',
        catalogsTitle: 'الكاتلوجات',
        catalogsDescription: 'ابدأ من القسم المناسب أو ابحث مباشرة عن المنتج، ثم أكمل الشراء ضمن واجهة أفخم وأكثر وضوحًا.',
        categoryDescription: 'منتجات هذا الكاتلوج تظهر في كروت حديثة مع صورة وسعر وزر شراء مباشر.',
        searchPlaceholder: 'ابحث عن منتج وسيظهر مباشرة أسفل البحث...',
        noResults: 'لا يوجد منتج مطابق',
        backToCatalogs: 'العودة إلى الكاتلوجات',
        backHome: 'العودة للرئيسية',
        catalogsBadge: 'الأقسام',
        productsBadge: 'منتج',
        categoryProductsTitle: 'منتجات الكاتلوج',
        emptyCatalogsTitle: 'لا توجد كاتلوجات جاهزة للعرض',
        emptyCatalogsDescription: 'عندما تتوفر أقسام مرتبطة بمنتجات ظاهرة في المتجر ستظهر هنا تلقائيًا.',
        emptyCategoryTitle: 'لا يوجد بها عناصر',
        emptyCategoryDescription: 'هذا القسم فارغ حاليًا، ويمكنك العودة لاختيار قسم آخر.',
        subCategories: 'الأقسام الفرعية',
        products: 'المنتجات',
        home: 'الرئيسية',
        backToCategories: 'الرجوع للأقسام',
        buyNow: 'شراء الآن',
      }
    : {
        pageKicker: 'Premium Storefront',
        catalogsTitle: 'Catalogs',
        catalogsDescription: 'Start from the right collection or search directly for a product, then continue purchasing inside a more premium flow.',
        categoryDescription: 'Products in this catalog use modern cards with image, pricing, and a direct purchase action.',
        searchPlaceholder: 'Search for a product and get direct matches...',
        noResults: 'No matching product found',
        backToCatalogs: 'Back to catalogs',
        backHome: 'Back home',
        catalogsBadge: 'catalogs',
        productsBadge: 'products',
        categoryProductsTitle: 'Catalog products',
        emptyCatalogsTitle: 'No catalogs are ready to display',
        emptyCatalogsDescription: 'Collections linked to visible storefront products will appear here automatically.',
        emptyCategoryTitle: 'There are no items in this category',
        emptyCategoryDescription: 'This category is currently empty, and you can return to choose another one.',
        subCategories: 'Sub-categories',
        products: 'Products',
        home: 'Home',
        backToCategories: 'Back to categories',
        buyNow: 'Buy now',
      }
);

const Products = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore((state) => state.user);
  const products = useMediaStore((state) => state.products);
  const categories = useMediaStore((state) => state.categories);
  const isLoading = useMediaStore((state) => state.isLoading);
  const loadProducts = useMediaStore((state) => state.loadProducts);
  const groupsLastLoadedAt = useGroupStore((state) => state.groupsLastLoadedAt);
  const loadCurrencies = useSystemStore((state) => state.loadCurrencies);
  const { i18n } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchResetSignal, setSearchResetSignal] = useState(0);
  const [selectedProduct, setSelectedProduct] = useState(null);

  const language = getStorefrontLanguage(i18n);
  const isRTL = language === 'ar';
  const copy = useMemo(() => getProductsPageCopy(language), [language]);
  const categorySlides = useMemo(() => ([
    { id: 'categories-slide-4', image: slideFourImage, title: '' },
    { id: 'categories-slide-3', image: slideThreeImage, title: '', href: '/referral' },
  ]), []);

  const activeCategoryParam = searchParams.get('category') || '';

  // ── Hierarchical navigation state ──────────────────────────────────────
  const [currentParentId, setCurrentParentId] = useState(null);
  const [activeSubcategoryId, setActiveSubcategoryId] = useState(null);

  useEffect(() => {
    const refreshProducts = () => {
      void loadProducts({ force: true, bypassCache: true });
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshProducts();
    };

    refreshProducts();
    window.addEventListener('focus', refreshProducts);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    const refreshInterval = window.setInterval(refreshProducts, 30_000);

    return () => {
      window.removeEventListener('focus', refreshProducts);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.clearInterval(refreshInterval);
    };
  }, [loadProducts]);

  useEffect(() => {
    loadCurrencies();
  }, [loadCurrencies]);

  const storefrontProducts = useMemo(
    () => createStorefrontProducts(products, {
      language,
      userGroup: user?.groupId || user?.group || 'Normal',
      userGroupPercentage: user?.groupPercentage ?? null,
    }),
    [groupsLastLoadedAt, language, products, user?.group, user?.groupId, user?.groupPercentage]
  );

  const storefrontCategories = useMemo(
    () => createStorefrontCategories(categories, storefrontProducts, language)
      .filter((category) => category.id !== 'all'),
    [categories, language, storefrontProducts]
  );

  // ── Hierarchy helpers ──────────────────────────────────────────────────

  /** Bulletproof parent ID extractor — handles string, ObjectId, populated object, undefined, empty string */
  const getParentId = useCallback((cat) => {
    if (!cat || !cat.parentCategory) return null;
    const p = cat.parentCategory;
    if (typeof p === 'object') return p._id || p.id || String(p) || null;
    if (typeof p === 'string') { const trimmed = p.trim(); return trimmed || null; }
    return String(p) || null;
  }, []);

  // Map of parentId → array of child categories
  const childrenMap = useMemo(() => {
    const map = new Map();
    for (const cat of storefrontCategories) {
      const parentId = getParentId(cat);
      if (!map.has(parentId)) map.set(parentId, []);
      map.get(parentId).push(cat);
    }
    return map;
  }, [storefrontCategories, getParentId]);

  // Check if a category has sub-categories
  const hasChildren = useCallback(
    (catId) => (childrenMap.get(catId) || []).length > 0,
    [childrenMap]
  );

  // ── Sync URL ?category= param with drill-down state on mount ───────────
  // If Dashboard navigates to /products?category=PARENT_ID, auto-drill-down
  useEffect(() => {
    if (!activeCategoryParam || isLoading) return;
    // Only act once: if we haven't drilled down yet
    if (currentParentId !== null) return;

    const catId = activeCategoryParam.trim();
    const catExists = storefrontCategories.some((c) => c.id === catId);
    if (!catExists) return;

    if (hasChildren(catId)) {
      // It's a parent category — drill down immediately
      setCurrentParentId(catId);
      // Clear the URL param so it doesn't interfere
      const next = new URLSearchParams(searchParams);
      next.delete('category');
      startTransition(() => {
        setSearchParams(next, { replace: true });
      });
    }
    // If it's a leaf category, the existing currentCatalog logic handles it
  }, [activeCategoryParam, isLoading, currentParentId, storefrontCategories, hasChildren, searchParams, setSearchParams]);

  // Categories at the current level — direct filter with robust string comparison
  const currentCategories = useMemo(
    () => storefrontCategories.filter((cat) => {
      const pid = getParentId(cat);
      if (currentParentId === null) return pid === null;
      return String(pid || '').trim() === String(currentParentId || '').trim();
    }),
    [storefrontCategories, currentParentId, getParentId]
  );

  // Build breadcrumb trail
  const breadcrumbTrail = useMemo(() => {
    if (!currentParentId) return [];
    const catMap = new Map(storefrontCategories.map((c) => [c.id, c]));
    const trail = [];
    let id = currentParentId;
    while (id) {
      const cat = catMap.get(id);
      if (!cat) break;
      trail.unshift(cat);
      id = getParentId(cat);
    }
    return trail;
  }, [storefrontCategories, currentParentId]);

  // Get all descendant IDs recursively for product filtering
  const getDescendantIds = useCallback((parentId) => {
    const ids = new Set();
    const queue = [parentId];
    while (queue.length > 0) {
      const id = queue.shift();
      const children = childrenMap.get(id) || [];
      for (const child of children) {
        ids.add(child.id);
        queue.push(child.id);
      }
    }
    return ids;
  }, [childrenMap]);

  // Products for the EXACT current category only (strict, no descendant rollup)
  const currentProducts = useMemo(() => {
    if (!currentParentId) return [];
    return storefrontProducts.filter((p) =>
      String(p.category || '').trim() === String(currentParentId).trim()
    );
  }, [currentParentId, storefrontProducts]);

  // ── Category selection logic ──────────────────────────────────────────

  const currentCatalog = useMemo(() => {
    if (!activeCategoryParam) return null;
    return storefrontCategories.find((category) => category.id === activeCategoryParam) || null;
  }, [activeCategoryParam, storefrontCategories]);

  const catalogProducts = useMemo(
    () => (
      currentCatalog
        ? storefrontProducts.filter((product) => String(product?.category || '').trim() === currentCatalog.id)
        : []
    ),
    [currentCatalog, storefrontProducts]
  );

  useEffect(() => {
    if (isLoading) return;

    const next = new URLSearchParams(searchParams);
    let shouldReplace = false;

    if (activeCategoryParam && !storefrontCategories.some((category) => category.id === activeCategoryParam)) {
      next.delete('category');
      shouldReplace = true;
    }

    if (shouldReplace) {
      startTransition(() => {
        setSearchParams(next, { replace: true });
      });
    }
  }, [
    activeCategoryParam,
    isLoading,
    searchParams,
    setSearchParams,
    storefrontCategories,
  ]);

  // ── Navigation handlers ────────────────────────────────────────────────

  const handleCategoryClick = useCallback((catId) => {
    if (hasChildren(catId)) {
      // Drill down into sub-categories
      setCurrentParentId(catId);
      setActiveSubcategoryId(null);
    } else {
      // Leaf category inside a drilled-down parent — isolate it
      if (currentParentId !== null) {
        setActiveSubcategoryId(catId);
        // Also set the URL param to load products for this leaf
        const next = new URLSearchParams(searchParams);
        next.set('category', catId);
        next.delete('request');
        setSearchResetSignal((value) => value + 1);
        startTransition(() => {
          setSearchParams(next);
        });
        return;
      }
      // Leaf category at root level — open via URL param
      const next = new URLSearchParams(searchParams);
      next.set('category', catId);
      next.delete('request');
      setSearchResetSignal((value) => value + 1);
      startTransition(() => {
        setSearchParams(next);
      });
    }
  }, [currentParentId, hasChildren, searchParams, setSearchParams]);

  const openCatalog = useCallback((catalogId) => {
    handleCategoryClick(catalogId);
  }, [handleCategoryClick]);

  const resetToCatalogs = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('category');
    next.delete('request');
    setSearchResetSignal((value) => value + 1);
    setCurrentParentId(null);
    setActiveSubcategoryId(null);

    startTransition(() => {
      setSearchParams(next);
    });
  }, [searchParams, setSearchParams]);

  const clearActiveSubcategory = useCallback(() => {
    setActiveSubcategoryId(null);
    const next = new URLSearchParams(searchParams);
    next.delete('category');
    next.delete('request');
    setSearchResetSignal((value) => value + 1);
    startTransition(() => {
      setSearchParams(next, { replace: true });
    });
  }, [searchParams, setSearchParams]);

  const openProduct = useCallback((product) => {
    setSelectedProduct(product);
  }, []);

  const closePurchaseDialog = useCallback(() => {
    setSelectedProduct(null);
  }, []);

  const viewCreatedOrder = useCallback((orderId) => {
    setSelectedProduct(null);
    navigate(`/orders/${encodeURIComponent(orderId)}`);
  }, [navigate]);

  const navigateBreadcrumb = useCallback((catId) => {
    const next = new URLSearchParams(searchParams);
    next.delete('category');
    next.delete('request');
    setSearchResetSignal((value) => value + 1);
    setCurrentParentId(catId);
    startTransition(() => {
      setSearchParams(next);
    });
  }, [searchParams, setSearchParams]);

  const showInitialLoading = isLoading && storefrontProducts.length === 0 && storefrontCategories.length === 0;

  // When viewing a specific leaf category via URL param
  const isViewingLeafCategory = Boolean(currentCatalog);

  // Products to display — from drill-down OR from leaf category selection
  const displayProducts = isViewingLeafCategory
    ? catalogProducts
    : (currentParentId ? currentProducts : []);

  const shouldMergeProductsWithSubcategories =
    currentParentId !== null && !activeSubcategoryId && currentCategories.length > 0;

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

  return (
    <div className="products-page space-y-5 pb-4 sm:space-y-6">
      <Seo
        title={seoData.title}
        description={seoData.description}
        keywords={seoData.keywords}
        canonicalUrl={seoData.canonicalUrl}
        image={seoImage}
        language={language}
        jsonLd={seoData.jsonLd}
      />

      <HeroSlider slides={categorySlides} />

      <section className="border-0 bg-transparent p-0 shadow-none">
        <div className="mx-auto flex w-full max-w-5xl justify-center">
          <ProductSearchBar
            products={storefrontProducts}
            language={language}
            resetSignal={searchResetSignal}
            onSelectProduct={openProduct}
            placeholder={copy.searchPlaceholder}
            noResultsLabel={copy.noResults}
            className="mx-auto w-full"
            inputClassName="h-12 rounded-2xl border-[color:rgb(var(--color-border-rgb)/0.68)] bg-[color:rgb(var(--color-surface-rgb)/0.56)] text-sm shadow-[var(--shadow-subtle)] focus:border-[#efc86f] focus:bg-[color:rgb(var(--color-surface-rgb)/0.72)] focus:ring-0 focus:shadow-[0_0_0_1px_rgba(239,200,111,0.42),0_0_16px_rgba(239,200,111,0.14)] sm:h-13 sm:rounded-[1.35rem]"
          />
        </div>
      </section>

      {showInitialLoading && (
        <LoadingSkeleton variant={currentCatalog ? 'products' : 'catalogs'} />
      )}

      {/* ── Breadcrumb navigation ─────────────────────────────────────── */}
      {!showInitialLoading && (currentParentId || isViewingLeafCategory) && (
        <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-1 rounded-2xl border border-[color:rgb(var(--color-border-rgb)/0.62)] bg-[color:rgb(var(--color-card-rgb)/0.52)] px-3 py-2 text-sm shadow-[var(--shadow-subtle)] backdrop-blur-xl">
          <button
            onClick={resetToCatalogs}
            className="font-medium text-[var(--color-primary)] hover:underline"
          >
            {copy.home}
          </button>
          {breadcrumbTrail.map((crumb) => (
            <span key={crumb.id} className="flex items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 text-[var(--color-text-secondary)]" />
              <button
                onClick={() => navigateBreadcrumb(crumb.id)}
                className="text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-primary)] hover:underline"
              >
                {crumb.title}
              </button>
            </span>
          ))}
        </nav>
      )}

      {/* ── Category & Product grid ────────────────────────────────── */}
      {!showInitialLoading && (
        <>
          {/* Root categories — wide banners (currentParentId is null) */}
          {currentCategories.length > 0 && currentParentId === null && !activeCategoryParam && (
            <section className="products-grid products-grid--categories grid grid-cols-2 gap-3 p-1 sm:gap-4 md:grid-cols-3 xl:grid-cols-4">
              {currentCategories.map((catalog, index) => (
                <CategoryCard
                  key={catalog.id}
                  category={catalog}
                  active={false}
                  index={index}
                  onSelect={openCatalog}
                />
              ))}
            </section>
          )}

          {/* Sub-categories — tight square cards (drilled into a parent) */}
          {shouldMergeProductsWithSubcategories && (
            <section className="products-grid products-grid--mixed grid grid-cols-3 gap-2 p-1 sm:gap-3 lg:grid-cols-4 xl:grid-cols-5">
              {currentCategories.map((catalog, index) => (
                <CategoryCard
                  key={catalog.id}
                  category={catalog}
                  active={false}
                  index={index}
                  onSelect={openCatalog}
                  variant="product"
                />
              ))}
              {currentCategories.length === 0 && displayProducts.map((product) => (
                <ProductCardSimple
                  key={product.id}
                  product={product}
                  onOpen={openProduct}
                  buyLabel={copy.buyNow}
                  unavailableLabel={language === 'ar' ? 'غير متاح' : 'Unavailable'}
                />
              ))}
            </section>
          )}

          {/* Active subcategory header + back button */}
          {activeSubcategoryId && currentParentId !== null && (() => {
            const activeSub = storefrontCategories.find((c) => c.id === activeSubcategoryId);
            return activeSub ? (
              <section className="px-4">
                <button
                  type="button"
                  onClick={clearActiveSubcategory}
                  className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-[color:rgb(var(--color-border-rgb)/0.6)] bg-[color:rgb(var(--color-surface-rgb)/0.6)] px-3 py-2 text-xs font-semibold text-[var(--color-primary)] shadow-sm backdrop-blur-xl transition-colors hover:bg-[color:rgb(var(--color-surface-rgb)/0.78)]"
                >
                  {isRTL ? <ArrowRight className="h-3.5 w-3.5" /> : <ArrowLeft className="h-3.5 w-3.5" />}
                  {copy.backToCategories}
                </button>
                <div className="flex items-center gap-3 rounded-[1.4rem] border border-[color:rgb(var(--color-border-rgb)/0.5)] bg-[color:rgb(var(--color-card-rgb)/0.64)] px-4 py-3 shadow-sm backdrop-blur-xl">
                  {activeSub.image && (
                    <img
                      src={activeSub.image}
                      alt={activeSub.title}
                      className="h-10 w-10 rounded-xl object-cover"
                    />
                  )}
                  <h2 className="text-base font-bold text-[var(--color-text)]">{activeSub.title}</h2>
                </div>
              </section>
            ) : null;
          })()}

          {/* Products — from leaf category or parent drill-down */}
          {displayProducts.length > 0 && !shouldMergeProductsWithSubcategories && (
            <section className="products-grid products-grid--items grid grid-cols-3 gap-2 p-1 sm:gap-3 lg:grid-cols-4 xl:grid-cols-5">
              {displayProducts.map((product) => (
                <ProductCardSimple
                  key={product.id}
                  product={product}
                  onOpen={openProduct}
                  buyLabel={copy.buyNow}
                  unavailableLabel={language === 'ar' ? 'غير متاح' : 'Unavailable'}
                />
              ))}
            </section>
          )}

          {/* Empty state — inside a category with no children and no products */}
          {(currentParentId || isViewingLeafCategory) && currentCategories.length === 0 && displayProducts.length === 0 && (
            <EmptyState
              icon={Layers3}
              title={copy.emptyCategoryTitle}
              description={copy.emptyCategoryDescription}
              actionLabel={copy.backToCatalogs}
              onAction={resetToCatalogs}
            />
          )}

          {/* Empty state — root level has no categories at all */}
          {!currentParentId && !isViewingLeafCategory && currentCategories.length === 0 && (
            <EmptyState
              icon={Search}
              title={copy.emptyCatalogsTitle}
              description={copy.emptyCatalogsDescription}
            />
          )}
        </>
      )}

      <ProductPurchaseDialog
        isOpen={Boolean(selectedProduct)}
        productId={selectedProduct?.id}
        initialProduct={selectedProduct}
        onClose={closePurchaseDialog}
        onViewOrder={viewCreatedOrder}
      />
    </div>
  );
};

export default Products;
