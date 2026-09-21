import React from 'react';
import { cn } from '../ui/Button';

const CategoryCard = ({
  category,
  active,
  activeLabel = 'Active',
  index,
  onSelect,
  variant = 'clean',
}) => {
  const isPlain = variant === 'plain';
  const isProductStyle = variant === 'product';

  if (isPlain || isProductStyle) {
    const imageSrc = String(category?.image || '').trim();
    const displayName = category?.title || 'Category';

    return (
      <button
        type="button"
        onClick={() => onSelect(category.id)}
        className={cn(
          'storefront-category-card group relative isolate flex w-full origin-center select-none flex-col text-start transition-all duration-200 ease-out hover:-translate-y-0.5',
          isProductStyle
            ? 'storefront-category-card--product storefront-product-card rounded-[1.25rem] p-2'
            : 'storefront-category-card--plain rounded-[1.4rem] hover:scale-[1.002]'
        )}
        aria-label={displayName}
        style={{ animation: 'page-fade-in 280ms ease-out both', animationDelay: `${Math.min(index * 35, 210)}ms` }}
      >
        <div className={cn(
          'storefront-category-media relative overflow-hidden',
          isProductStyle ? 'storefront-product-media rounded-[1rem]' : 'rounded-[1.2rem]'
        )}>
          {imageSrc ? (
            <img
              src={imageSrc}
              alt={displayName}
              loading="lazy"
              decoding="async"
              sizes={isProductStyle ? '(max-width: 640px) 32vw, (max-width: 1024px) 24vw, 18vw' : '(max-width: 640px) 45vw, (max-width: 1024px) 24vw, 18vw'}
              className={cn(
                'relative block aspect-square h-full w-full bg-transparent object-contain object-center transition duration-500 group-hover:scale-[1.05]',
                isProductStyle && 'p-2 group-hover:scale-[1.04]'
              )}
            />
          ) : (
            <div
              aria-hidden="true"
              className="relative grid aspect-square h-full w-full place-items-center rounded-[1.2rem] border border-[color:rgb(var(--color-border-rgb)/0.72)] bg-[color:rgb(var(--color-surface-rgb)/0.72)] text-2xl font-black text-[var(--color-text-secondary)] transition duration-500 group-hover:scale-[1.03]"
            >
              {String(displayName).slice(0, 1).toUpperCase()}
            </div>
          )}
        </div>

        <h3 className={cn(
          'storefront-category-title mt-2 text-[var(--color-text)] transition-colors duration-200 group-hover:text-[var(--color-primary)]',
          isProductStyle
            ? 'storefront-product-title line-clamp-1 text-center text-[0.78rem] font-bold leading-5 sm:text-sm'
            : 'line-clamp-2 text-sm font-semibold leading-5'
        )}>
          {displayName}
        </h3>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(category.id)}
      className={cn(
        'storefront-category-card storefront-category-card--clean group relative flex flex-col overflow-visible rounded-[1.9rem] border-0 bg-transparent text-start shadow-none transition-all hover:-translate-y-0.5 hover:scale-[1.002]',
        active ? 'border-transparent bg-transparent' : 'border-transparent bg-transparent'
      )}
      style={{ animation: 'page-fade-in 280ms ease-out both', animationDelay: `${Math.min(index * 35, 210)}ms` }}
    >
      <div className="flex w-full justify-center">
        <div className="relative inline-block max-w-full overflow-hidden rounded-[1.35rem]">
          <img
            src={category.image}
            alt={category.title}
            loading="lazy"
            decoding="async"
            sizes="(max-width: 768px) 50vw, (max-width: 1024px) 33vw, 20vw"
            className={cn(
              'relative block h-auto max-w-full bg-transparent transition-transform duration-500',
              category.id === 'all' ? 'p-3' : ''
            )}
          />
        </div>
      </div>

      <div className="relative px-3 pb-2 pt-1 text-center sm:px-4">
        {active && (
          <span className="mb-2 inline-flex rounded-full border border-[color:rgb(var(--color-primary-rgb)/0.16)] bg-[color:rgb(var(--color-primary-rgb)/0.08)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-primary)]">
            {activeLabel}
          </span>
        )}
        <h3 className="line-clamp-2 text-center text-[0.98rem] font-semibold leading-6 text-[var(--color-text)]">
          {category.title}
        </h3>
      </div>
    </button>
  );
};

export default React.memo(CategoryCard);
