import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { AlertCircle, CheckCircle, Copy, Hash, Info, Landmark, Loader, ReceiptText, ShieldCheck, Smartphone, Sparkles, WalletCards } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import UploadReceiptBox from '../components/wallet/UploadReceiptBox';
import { useLanguage } from '../context/LanguageContext';
import useSystemStore from '../store/useSystemStore';
import useTopupStore from '../store/useTopupStore';
import useAuthStore from '../store/useAuthStore';
import { useToast } from '../components/ui/Toast';
import { inputBaseClassName, textareaClassName } from '../components/ui/Input';
import { findPaymentMethodById } from '../utils/paymentSettings';
import { devLogger } from '../utils/devLogger';
import { resolveImageUrl } from '../utils/imageUrl';
import { getCurrencySymbol } from '../utils/storefront';

const normalizeMethodType = (type) => String(type || '').trim().toLowerCase();

const isVodafoneCashMethod = (method) => {
  const token = `${method?.id || ''} ${method?.name || ''}`.trim().toLowerCase();
  return token.includes('vodafone') || token.includes('فودافون');
};

const requiresTransactionNumber = (method) => {
  const type = normalizeMethodType(method?.type);
  return ['mobile_wallet', 'e_wallet', 'ewallet'].includes(type);
};

const getReceiverDestination = (method) => {
  const accountNumber = String(method?.accountNumber || '').trim();
  const accountName = String(method?.accountName || '').trim();
  const methodType = normalizeMethodType(method?.type);
  const methodToken = `${method?.name || ''} ${methodType}`.toLowerCase();
  const destination = {
    receiverPhone: '',
    receiverWallet: '',
    receiverUID: '',
    receiverEmail: '',
    receiverName: accountName,
    receiverWalletAddress: '',
  };

  if (!accountNumber) return destination;

  if (methodToken.includes('binance') || methodToken.includes('بينانس')) {
    if (accountNumber.includes('@')) destination.receiverEmail = accountNumber;
    else destination.receiverUID = accountNumber;
  } else if (methodType === 'usdt' || methodType === 'crypto') {
    destination.receiverWalletAddress = accountNumber;
  } else if (['mobile_wallet', 'e_wallet', 'ewallet'].includes(methodType)) {
    destination.receiverPhone = accountNumber;
  } else {
    destination.receiverWallet = accountNumber;
  }

  return destination;
};

const FieldCompletionBadge = ({ complete }) => (
  <span
    className={complete
      ? 'inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-[9px] font-black text-emerald-500'
      : 'rounded-full bg-rose-500/10 px-2 py-0.5 text-[9px] font-black text-rose-500'}
  >
    {complete ? (
      <>
        <CheckCircle className="h-3 w-3" />
        تم
      </>
    ) : 'مطلوب'}
  </span>
);

const getSenderDetailRequirement = (method) => {
  const type = normalizeMethodType(method?.type);

  if (isVodafoneCashMethod(method)) {
    return null;
  }

  if (type === 'mobile_wallet' || type === 'e_wallet' || type === 'ewallet') {
    return {
      field: 'senderWalletNumber',
      label: 'رقم المحفظة المحول منها',
      placeholder: 'أدخل رقم المحفظة التي تم التحويل منها',
      validationMessage: 'يرجى إدخال رقم المحفظة المحول منها',
    };
  }

  if (type === 'usdt' || type === 'crypto') {
    return {
      field: 'senderWalletAddress',
      label: 'عنوان المحفظة المحول منها',
      placeholder: 'أدخل عنوان محفظة USDT التي تم التحويل منها',
      validationMessage: 'يرجى إدخال عنوان المحفظة المحول منها',
    };
  }

  return null;
};

const getMethodPresentation = (method) => {
  const token = `${method?.id || ''} ${method?.name || ''}`.toLowerCase();
  const type = normalizeMethodType(method?.type);

  if (token.includes('vodafone')) return { icon: 'VC', color: 'from-red-500 to-yellow-500' };
  if (token.includes('etisalat')) return { icon: 'EC', color: 'from-green-500 to-indigo-500' };
  if (token.includes('orange')) return { icon: 'OC', color: 'from-orange-500 to-red-500' };
  if (type === 'bank_transfer') return { icon: 'BT', color: 'from-indigo-500 to-amber-500' };
  if (type === 'usdt' || type === 'crypto') return { icon: 'USDT', color: 'from-emerald-500 to-indigo-600' };
  if (type === 'credit_card') return { icon: 'CC', color: 'from-amber-500 to-orange-600' };

  return { icon: 'PM', color: 'from-emerald-500 to-indigo-600' };
};

const getCurrencyRate = (currencies = [], currencyCode = 'USD') => {
  const normalizedCode = String(currencyCode || '').trim().toUpperCase();
  if (!normalizedCode) return null;

  const matchedCurrency = (Array.isArray(currencies) ? currencies : []).find(
    (currency) => (
      currency?.isActive !== false
      && String(currency?.code || '').trim().toUpperCase() === normalizedCode
    )
  );
  const matchedRate = Number(matchedCurrency?.rate);
  if (Number.isFinite(matchedRate) && matchedRate > 0) return matchedRate;

  if (normalizedCode === 'USD') return 1;
  return null;
};

const PaymentDetails = ({
  embedded = false,
  methodId: embeddedMethodId = '',
  automaticAmount = null,
  automaticCurrency = '',
  onBack = null,
  onComplete = null,
  onReturnToPurchase = null,
}) => {
  const { methodId: routeMethodId } = useParams();
  const methodId = embeddedMethodId || routeMethodId;
  const { dir } = useLanguage();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuthStore();
  const { paymentSettings, currencies, loadPaymentSettings, loadCurrencies } = useSystemStore();
  const { addToast } = useToast();
  const isRTL = dir === 'rtl';
  const automaticTopupAmount = Number(automaticAmount ?? searchParams.get('amount') ?? 0);
  const automaticTopupCurrency = String(automaticCurrency || searchParams.get('currency') || user?.currency || 'USD').toUpperCase();
  const isAutomaticTopup = (embedded || searchParams.get('mode') === 'auto')
    && Number.isFinite(automaticTopupAmount)
    && automaticTopupAmount > 0;
  const automaticTopupPrefilled = useRef(false);

  const [formData, setFormData] = useState({
    amount: '',
    cardNumber: '',
    expiryDate: '',
    cvv: '',
    senderWalletNumber: '',
    senderWalletAddress: '',
    transactionId: '',
    notes: '',
  });
  const [uploadedFile, setUploadedFile] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState(null);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (submitStatus !== 'success') return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [submitStatus]);

  useEffect(() => {
    loadPaymentSettings({ force: true });
    loadCurrencies();
  }, [loadPaymentSettings, loadCurrencies]);

  const selectedMethodEntry = useMemo(
    () => findPaymentMethodById(paymentSettings, methodId, { fallbackToDefault: false }),
    [paymentSettings, methodId]
  );

  const group = selectedMethodEntry?.group || null;
  const method = selectedMethodEntry?.method || null;
  const needsTransactionNumber = requiresTransactionNumber(method);
  const receiverDestination = useMemo(
    () => getReceiverDestination(method),
    [method]
  );

  const methodPresentation = useMemo(
    () => getMethodPresentation(method),
    [method]
  );

  const methodFields = method?.fields || ['amount'];
  const senderDetailRequirement = useMemo(
    () => getSenderDetailRequirement(method),
    [method]
  );
  const visibleMethodFields = useMemo(
    () => methodFields.filter((field) => !['senderNumber', 'senderWalletNumber', 'senderWalletAddress', 'transactionId', 'transactionNumber', 'paymentReference'].includes(field)),
    [methodFields]
  );
  const methodInstructions = String(method?.instructions || '').trim();
  const requiresReceipt =
    normalizeMethodType(method?.type) !== 'site_wallet'
    && !isVodafoneCashMethod(method);
  const feePercent = useMemo(() => {
    const value = Number(method?.feePercent);
    if (!Number.isFinite(value)) return 0;
    return Math.min(100, Math.max(0, value));
  }, [method?.feePercent]);
  const enteredAmount = Number(formData.amount || 0);
  const baseAmount = Number.isFinite(enteredAmount) && enteredAmount > 0 ? enteredAmount : 0;
  const feeAmount = Number(((baseAmount * feePercent) / 100).toFixed(2));
  const payableAmount = Number((baseAmount + feeAmount).toFixed(2));
  const paymentCurrencyCode = String(group?.currency || method?.currency || user?.currency || 'USD').toUpperCase();
  const paymentCurrencySymbol = useMemo(() => {
    const configuredCurrency = (Array.isArray(currencies) ? currencies : []).find(
      (currency) => String(currency?.code || '').trim().toUpperCase() === paymentCurrencyCode
    );
    return String(configuredCurrency?.symbol || getCurrencySymbol(paymentCurrencyCode));
  }, [currencies, paymentCurrencyCode]);
  const paymentCurrencyRate = useMemo(
    () => getCurrencyRate(currencies, paymentCurrencyCode),
    [currencies, paymentCurrencyCode]
  );
  const usdCurrencyRate = useMemo(
    () => getCurrencyRate(currencies, 'USD') || 1,
    [currencies]
  );

  useEffect(() => {
    if (automaticTopupPrefilled.current || !isAutomaticTopup) return;
    if (!Number.isFinite(automaticTopupAmount) || automaticTopupAmount <= 0 || !method) return;

    const sourceRate = getCurrencyRate(currencies, automaticTopupCurrency);
    const targetRate = getCurrencyRate(currencies, paymentCurrencyCode);
    if (!sourceRate || !targetRate) return;

    const convertedAmount = (automaticTopupAmount / sourceRate) * targetRate;
    if (!Number.isFinite(convertedAmount) || convertedAmount <= 0) return;

    setFormData((previous) => ({
      ...previous,
      amount: previous.amount || String(Number(convertedAmount.toFixed(2))),
    }));
    automaticTopupPrefilled.current = true;
  }, [automaticTopupAmount, automaticTopupCurrency, currencies, isAutomaticTopup, method, paymentCurrencyCode]);
  const usdPreviewAmount = useMemo(() => {
    const amountValue = Number(formData.amount);
    if (!Number.isFinite(amountValue) || amountValue <= 0) return null;
    if (!Number.isFinite(paymentCurrencyRate) || paymentCurrencyRate <= 0) return null;

    const convertedAmount = (amountValue / paymentCurrencyRate) * usdCurrencyRate;
    if (!Number.isFinite(convertedAmount) || convertedAmount < 0.01) return null;

    return convertedAmount;
  }, [formData.amount, paymentCurrencyRate, usdCurrencyRate]);
  const usdPreviewLabel = useMemo(() => {
    if (!Number.isFinite(usdPreviewAmount) || usdPreviewAmount <= 0) return '';

    const formattedAmount = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(usdPreviewAmount);

    return `≈ ${formattedAmount} USD`;
  }, [usdPreviewAmount]);

  const formatMoney = (value) => {
    const safeValue = Number(value || 0);

    try {
      return new Intl.NumberFormat(isRTL ? 'ar-EG-u-nu-latn' : 'en-US-u-nu-latn', {
        style: 'currency',
        currency: paymentCurrencyCode,
        numberingSystem: 'latn',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(safeValue);
    } catch (_error) {
      return `${safeValue.toFixed(2)} ${paymentCurrencyCode}`;
    }
  };

  const handleInputChange = (field, value) => {
    setFormError('');
    setSubmitStatus(null);
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleReceiptUpload = (file) => {
    setFormError('');
    setSubmitStatus(null);
    setUploadedFile(file);
  };

  const handleCopyAccount = async () => {
    const value = String(method?.accountNumber || '').trim();
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      addToast(
        t('payments.copySuccess', { defaultValue: dir === 'rtl' ? 'تم نسخ الرقم' : 'Number copied' }),
        'success'
      );
    } catch (_error) {
      addToast(
        t('payments.copyFailed', { defaultValue: dir === 'rtl' ? 'تعذر نسخ الرقم' : 'Unable to copy number' }),
        'error'
      );
    }
  };

  const validate = () => {
    const amountValue = Number(formData.amount);
    if (!Number.isFinite(amountValue) || amountValue <= 0) return t('payments.validationAmount');
    if (senderDetailRequirement && !String(formData[senderDetailRequirement.field] || '').trim()) {
      return senderDetailRequirement.validationMessage;
    }
    if (needsTransactionNumber && !String(formData.transactionId || '').trim()) {
      return 'يرجى إدخال رقم العملية';
    }
    if (requiresReceipt && !uploadedFile) return t('payments.validationReceipt');
    return '';
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const validationMessage = validate();
    if (validationMessage) {
      setFormError(validationMessage);
      setSubmitStatus(null);
      addToast(validationMessage, 'error');
      return;
    }

    setFormError('');
    setSubmitStatus(null);
    setIsSubmitting(true);
    try {
      const freshSettings = await loadPaymentSettings({ force: true });
      const freshEntry = findPaymentMethodById(freshSettings, methodId, { fallbackToDefault: false });
      const freshMethod = freshEntry?.method || null;
      const freshGroup = freshEntry?.group || null;

      if (!freshMethod) {
        addToast('طريقة الدفع لم تعد متاحة. تم تحديث البيانات من السيرفر.', 'error');
        if (onBack) onBack();
        else navigate('/wallet/add-balance');
        return;
      }

      const freshFeePercentValue = Number(freshMethod?.feePercent);
      const freshFeePercent = Number.isFinite(freshFeePercentValue)
        ? Math.min(100, Math.max(0, freshFeePercentValue))
        : 0;
      const freshFeeAmount = Number(((baseAmount * freshFeePercent) / 100).toFixed(2));
      const freshPayableAmount = Number((baseAmount + freshFeeAmount).toFixed(2));
      const freshSenderRequirement = getSenderDetailRequirement(freshMethod);
      const senderValue = freshSenderRequirement
        ? String(formData[freshSenderRequirement.field] || '').trim()
        : '';
      const transactionId = String(formData.transactionId || '').trim();
      const freshNeedsTransactionNumber = requiresTransactionNumber(freshMethod);

      if (freshSenderRequirement && !senderValue) {
        addToast(freshSenderRequirement.validationMessage, 'error');
        setFormError(freshSenderRequirement.validationMessage);
        return;
      }
      if (freshNeedsTransactionNumber && !transactionId) {
        addToast('يرجى إدخال رقم العملية', 'error');
        setFormError('يرجى إدخال رقم العملية');
        return;
      }

      const senderDetails = freshSenderRequirement ? {
        methodType: normalizeMethodType(freshMethod?.type),
        field: freshSenderRequirement.field,
        label: freshSenderRequirement.label,
        value: senderValue,
        transactionNumber: freshNeedsTransactionNumber ? transactionId : '',
      } : null;
      const { requestTopup } = useTopupStore.getState();

      await requestTopup({
        requestedAmount: baseAmount,
        amount: baseAmount,
        paymentMethodId: freshMethod?.id || '',
        paymentFeePercent: freshFeePercent,
        paymentFeeAmount: freshFeeAmount,
        amountWithFee: freshPayableAmount,
        senderDetails,
        senderWalletNumber: freshSenderRequirement?.field === 'senderWalletNumber' ? senderValue : '',
        senderWalletAddress: freshSenderRequirement?.field === 'senderWalletAddress' ? senderValue : '',
        transferredFromNumber: senderValue,
        transactionId: freshNeedsTransactionNumber ? transactionId : '',
        transactionNumber: freshNeedsTransactionNumber ? transactionId : '',
        paymentReference: freshNeedsTransactionNumber ? transactionId : '',
        proofImage: uploadedFile || null,
        paymentChannel: freshMethod?.name || methodId || '',
        paymentMethodType: normalizeMethodType(freshMethod?.type),
        currencyCode: freshGroup?.currency || freshMethod?.currency || user?.currency || 'USD',
        userId: user?.id || '',
        userName: user?.name || '',
        notes: formData.notes || '',
        type: 'regular',
      });

      setSubmitStatus('success');
    } catch (error) {
      devLogger.warnUnlessBenign('Topup submission failed:', error);
      setFormError(t('payments.submitErrorDesc'));
      setSubmitStatus('error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSuccessConfirm = () => {
    if (onComplete) onComplete();
    else navigate('/wallet/topups');
  };

  const handleSuccessCancel = () => {
    if (onReturnToPurchase) {
      onReturnToPurchase();
      return;
    }
    setSubmitStatus(null);
  };

  const fieldConfigs = {
    amount: {
      label: t('payments.fields.amount'),
      placeholder: t('payments.fields.amountPlaceholder'),
      type: 'number',
      min: '0.01',
      step: '0.01',
    },
    senderNumber: {
      label: t('payments.fields.senderNumber'),
      placeholder: t('payments.fields.senderNumberPlaceholder'),
      type: 'tel',
    },
    transactionId: {
      label: t('payments.fields.transactionId'),
      placeholder: t('payments.fields.transactionIdPlaceholder'),
      type: 'text',
    },
    cardNumber: {
      label: t('payments.fields.cardNumber'),
      placeholder: t('payments.fields.cardNumberPlaceholder'),
      type: 'text',
    },
    expiryDate: {
      label: t('payments.fields.expiryDate'),
      placeholder: t('payments.fields.expiryDatePlaceholder'),
      type: 'text',
    },
    cvv: {
      label: t('payments.fields.cvv'),
      placeholder: t('payments.fields.cvvPlaceholder'),
      type: 'text',
    },
  };

  if (!method) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="rounded-2xl border border-gray-200 bg-white/80 p-8 text-center dark:border-gray-800 dark:bg-gray-900/70">
          <h1 className="mb-2 text-2xl font-bold text-gray-900 dark:text-white">{t('payments.invalidMethodTitle')}</h1>
          <button
            type="button"
            onClick={() => (onBack ? onBack() : navigate('/wallet/add-balance'))}
            className="text-sm font-semibold text-indigo-600 hover:text-indigo-700 dark:text-indigo-300 dark:hover:text-indigo-200"
          >
            {t('payments.invalidMethodAction')}
          </button>
        </div>
      </div>
    );
  }

  const flowSteps = [
    ...(method.accountNumber ? [{ label: dir === 'rtl' ? 'التحويل' : 'Transfer' }] : []),
    { label: dir === 'rtl' ? 'البيانات' : 'Details' },
    ...(requiresReceipt ? [{ label: dir === 'rtl' ? 'الإيصال' : 'Receipt' }] : []),
  ];
  const paymentInputClassName = `${inputBaseClassName} h-12 rounded-xl border-[color:rgb(var(--color-border-rgb)/0.72)] bg-[color:rgb(var(--color-surface-rgb)/0.72)] px-4 text-sm font-bold shadow-none hover:border-cyan-500/35 focus:border-cyan-500/65 focus:bg-[var(--color-card)] focus:ring-cyan-500/10`;

  return (
    <div className={embedded ? 'w-full min-w-0 overflow-x-hidden pb-2' : 'pb-6'} dir={dir}>
      <div className="mx-auto w-full min-w-0 max-w-3xl space-y-3 sm:space-y-4">
        {embedded && onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="inline-flex h-9 items-center justify-center rounded-xl border border-[color:rgb(var(--color-primary-rgb)/0.22)] bg-[color:rgb(var(--color-primary-rgb)/0.08)] px-3 text-xs font-black text-[var(--color-primary)] transition hover:bg-[color:rgb(var(--color-primary-rgb)/0.14)]"
          >
            {dir === 'rtl' ? 'العودة لوسائل الدفع' : 'Back to payment methods'}
          </button>
        ) : null}
        <motion.div
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className="flex items-center gap-3 border-b border-[color:rgb(var(--color-border-rgb)/0.68)] px-1 pb-4"
        >
          {method.image ? (
            <img
              src={resolveImageUrl(method.image)}
              alt={method.name}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="h-11 w-11 shrink-0 rounded-xl border border-[color:rgb(var(--color-border-rgb)/0.68)] bg-white object-contain p-1"
            />
          ) : (
            <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${methodPresentation.color}`}>
              <span className="text-[10px] font-bold text-white">{methodPresentation.icon}</span>
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-black tracking-tight text-[var(--color-text)] sm:text-lg">{method.name}</h1>
            <p className="mt-0.5 truncate text-[10px] font-bold text-[var(--color-text-secondary)] sm:text-xs">
              {group?.name || (dir === 'rtl' ? 'إضافة رصيد' : 'Add balance')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-[9px] font-black text-emerald-500">
              <ShieldCheck className="h-3.5 w-3.5" />
              {dir === 'rtl' ? 'دفع آمن' : 'Secure'}
            </span>
            {group?.currency ? (
              <span className="rounded-md bg-indigo-500/[0.08] px-1.5 py-1 font-['Poppins'] text-[9px] font-black text-indigo-500">
                {String(group.currency).toUpperCase()}
              </span>
            ) : null}
          </div>
        </motion.div>

        <div className="flex items-start px-2 py-2 sm:px-10">
          {flowSteps.map((step, index) => (
            <React.Fragment key={step.label}>
              <div className="flex w-16 shrink-0 flex-col items-center text-center sm:w-20">
                <span className="grid h-7 w-7 place-items-center rounded-full border-2 border-cyan-500 bg-[var(--color-card)] font-['Poppins'] text-[10px] font-black text-cyan-600 dark:text-cyan-300">
                  {index + 1}
                </span>
                <span className="mt-1.5 text-[9px] font-black text-[var(--color-text-secondary)]">{step.label}</span>
              </div>
              {index < flowSteps.length - 1 ? (
                <span className="mt-3.5 h-px min-w-4 flex-1 bg-gradient-to-l from-cyan-500/60 to-indigo-500/20" />
              ) : null}
            </React.Fragment>
          ))}
        </div>

        <div className="min-w-0">
        {method.accountNumber && (
          <motion.div
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.25, delay: 0.05, ease: 'easeOut' }}
            className="min-w-0 border-y border-[color:rgb(var(--color-border-rgb)/0.62)] py-5"
          >
            <div className="mb-4 flex items-center gap-2.5">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-cyan-500/10 text-cyan-600 dark:text-cyan-300">
                <Landmark className="h-4 w-4" />
              </span>
              <div>
                <h3 className="text-sm font-black text-[var(--color-text)]">{t('payments.accountDetails')}</h3>
                <p className="mt-0.5 text-[10px] text-[var(--color-text-secondary)]">{dir === 'rtl' ? 'حوّل المبلغ إلى الرقم التالي' : 'Transfer the amount to this number'}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleCopyAccount}
              className="group relative flex w-full items-center justify-between gap-3 overflow-hidden rounded-2xl bg-[linear-gradient(135deg,#082f49_0%,#0e7490_48%,#2563eb_100%)] px-4 py-4 text-white shadow-[0_20px_45px_-28px_rgba(8,145,178,0.9)] transition hover:-translate-y-0.5 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-cyan-400/50 focus:ring-offset-2 focus:ring-offset-[var(--color-bg)] sm:px-5"
              title={dir === 'rtl' ? 'اضغط للنسخ' : 'Tap to copy'}
            >
              <span className="pointer-events-none absolute -top-10 end-5 h-24 w-24 rounded-full bg-cyan-300/20 blur-2xl" />
              <span className="relative min-w-0 text-start">
                <span className="block text-[9px] font-bold text-cyan-100/75">{dir === 'rtl' ? 'رقم التحويل' : 'Transfer number'}</span>
                <span className="mt-1 block break-all font-['Poppins'] text-xl font-black tracking-[0.08em] [direction:ltr] sm:text-2xl">{method.accountNumber}</span>
              </span>
              <span className="relative inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-white/15 bg-white/10 px-2.5 py-2 text-[10px] font-black text-white backdrop-blur-sm transition group-hover:bg-white/20">
                <Copy className="h-3.5 w-3.5" />
                {dir === 'rtl' ? 'نسخ' : 'Copy'}
              </span>
            </button>
            <p className="mt-2 text-center text-[9px] font-bold text-cyan-600 dark:text-cyan-300">{dir === 'rtl' ? 'اضغط على الرقم لنسخه فورًا' : 'Tap the number to copy it instantly'}</p>
            <div className="relative mt-4 grid grid-cols-2 border-b border-[color:rgb(var(--color-border-rgb)/0.5)] pb-3 text-start after:absolute after:inset-y-2 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-gradient-to-b after:from-transparent after:via-cyan-500/35 after:to-transparent">
              {method.accountName && (
                <div className="min-w-0 px-3 py-2 sm:px-5">
                  <p className="text-[9px] font-bold text-[var(--color-text-secondary)]">
                    {t('payments.accountHolder', { defaultValue: dir === 'rtl' ? 'اسم صاحب الحساب' : 'Account holder' })}
                  </p>
                  <p className="mt-1 break-words text-xs font-black text-[var(--color-text)]">{method.accountName}</p>
                </div>
              )}
              {method.bankName && (
                <div className="min-w-0 px-3 py-2 sm:px-5">
                  <p className="text-[9px] font-bold text-[var(--color-text-secondary)]">{dir === 'rtl' ? 'جهة التحويل' : 'Transfer provider'}</p>
                  <p className="mt-1 break-words text-xs font-black text-[var(--color-text)]">{method.bankName}</p>
                </div>
              )}
            </div>
          </motion.div>
        )}

        {methodInstructions ? (
          <motion.aside
            initial={{ y: 8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.25, delay: 0.07, ease: 'easeOut' }}
            role="note"
            className="relative isolate my-4 overflow-hidden rounded-2xl border border-amber-300/60 bg-[linear-gradient(135deg,#fffbeb_0%,#fff7ed_54%,#ffffff_100%)] p-4 shadow-[0_20px_44px_-34px_rgb(217_119_6/0.62)] dark:border-amber-300/20 dark:bg-[radial-gradient(18rem_circle_at_100%_0%,rgb(245_158_11/0.16),transparent_52%),linear-gradient(135deg,rgb(50_36_12/0.7),rgb(var(--color-card-rgb)/0.82))]"
          >
            <span className="pointer-events-none absolute -end-8 -top-10 -z-10 h-28 w-28 rounded-full bg-amber-300/25 blur-2xl" />
            <span className="pointer-events-none absolute end-3 top-3 text-amber-500/30"><Sparkles className="h-5 w-5" /></span>
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-amber-300/70 bg-[linear-gradient(145deg,#facc15,#f59e0b)] text-amber-950 shadow-[0_12px_26px_-18px_rgb(217_119_6/0.9)]">
                <Info className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-xs font-black text-amber-950 dark:text-amber-100">
                    {dir === 'rtl' ? 'تعليمات مهمة لهذه الوسيلة' : 'Important payment instructions'}
                  </h3>
                  <span className="rounded-full border border-amber-400/35 bg-amber-200/55 px-2 py-0.5 text-[8px] font-black text-amber-800 dark:bg-amber-400/10 dark:text-amber-200">
                    {dir === 'rtl' ? 'يرجى القراءة' : 'Please read'}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-line break-words text-xs font-semibold leading-6 text-amber-950/80 dark:text-amber-50/80">
                  {methodInstructions}
                </p>
              </div>
            </div>
          </motion.aside>
        ) : null}

        <motion.form
          initial={{ y: 10, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.25, delay: 0.08, ease: 'easeOut' }}
          onSubmit={handleSubmit}
          className="mx-auto min-w-0 max-w-2xl py-5"
        >
          <div className="mb-5 flex items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-500 dark:text-indigo-300">
              <ReceiptText className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-sm font-black text-[var(--color-text)]">{t('payments.paymentDetails')}</h3>
              <p className="mt-0.5 text-[10px] text-[var(--color-text-secondary)]">{dir === 'rtl' ? 'أدخل بيانات التحويل كما تظهر في الإيصال' : 'Enter the transfer details shown on your receipt'}</p>
            </div>
          </div>

          {visibleMethodFields.map((field) => {
            const config = fieldConfigs[field];
            if (!config) return null;

            return (
              <div key={field} className="mb-3">
                <label className={`mb-1.5 flex items-center justify-between gap-2 text-xs font-black text-[var(--color-text)] ${isRTL ? 'text-right' : 'text-left'}`}>
                  <span>{config.label}</span>
                  {field === 'amount' ? (
                    <FieldCompletionBadge complete={Number(formData.amount) > 0} />
                  ) : null}
                </label>
                {field === 'amount' ? (
                  <div
                    className="flex h-12 overflow-hidden rounded-xl border border-amber-400/55 bg-[color:rgb(var(--color-surface-rgb)/0.72)] shadow-inner shadow-black/5 transition focus-within:border-amber-500 focus-within:ring-2 focus-within:ring-amber-400/15 dark:bg-[linear-gradient(110deg,rgb(15_23_42/0.82),rgb(30_27_18/0.76))] dark:shadow-black/15"
                    dir={dir}
                  >
                    <span
                      className="grid min-w-16 shrink-0 place-items-center border-e border-amber-500/55 bg-[linear-gradient(145deg,#fde047,#facc15_55%,#eab308)] px-3 font-['Poppins'] text-xl font-black text-slate-950 shadow-[0_0_24px_-12px_rgb(234_179_8/0.9)]"
                      dir="ltr"
                      title={paymentCurrencyCode}
                    >
                      {paymentCurrencySymbol}
                    </span>
                    <input
                      type={config.type}
                      value={formData[field] || ''}
                      onChange={(e) => handleInputChange(field, e.target.value)}
                      placeholder={config.placeholder}
                      min={config.min}
                      step={config.step}
                      className="payment-amount-input min-w-0 flex-1 appearance-none bg-transparent px-4 text-right font-['Poppins'] text-base font-black text-[var(--color-text)] outline-none placeholder:text-right placeholder:font-semibold placeholder:text-[var(--color-text-secondary)] [font-variant-numeric:tabular-nums]"
                      disabled={isSubmitting}
                    />
                  </div>
                ) : (
                  <input
                    type={config.type}
                    value={formData[field] || ''}
                    onChange={(e) => handleInputChange(field, e.target.value)}
                    placeholder={config.placeholder}
                    min={config.min}
                    step={config.step}
                    className={`${paymentInputClassName} ${isRTL ? 'text-right' : 'text-left'}`}
                    disabled={isSubmitting}
                  />
                )}
                {field === 'amount' && usdPreviewLabel && (
                  <p className="mt-1.5 px-1 text-[10px] font-black text-emerald-600 dark:text-emerald-300 [direction:ltr]">
                    {usdPreviewLabel}
                  </p>
                )}
              </div>
            );
          })}

          <div className="grid gap-x-4 sm:grid-cols-2">
          {senderDetailRequirement && (
            <div className="mb-4">
              <label className={`mb-1.5 flex items-center justify-between gap-2 text-xs font-black text-[var(--color-text)] ${isRTL ? 'text-right' : 'text-left'}`}>
                <span>{senderDetailRequirement.label}</span>
                <FieldCompletionBadge complete={Boolean(String(formData[senderDetailRequirement.field] || '').trim())} />
              </label>
              {senderDetailRequirement.field === 'senderWalletNumber' ? (
                <div
                  className="flex h-12 overflow-hidden rounded-xl border border-rose-400/55 bg-rose-50/45 shadow-inner shadow-black/5 transition focus-within:border-rose-500 focus-within:ring-2 focus-within:ring-rose-400/15 dark:bg-[linear-gradient(110deg,rgb(31_18_25/0.82),rgb(15_23_42/0.78))] dark:shadow-black/15"
                  dir={dir}
                >
                  <span className="grid min-w-16 shrink-0 place-items-center border-e border-rose-600/55 bg-[linear-gradient(145deg,#fb7185,#e11d48_58%,#be123c)] text-white shadow-[0_0_24px_-12px_rgb(225_29_72/0.9)]">
                    <Smartphone className="h-5 w-5 drop-shadow-sm" />
                  </span>
                  <input
                    type="tel"
                    inputMode="numeric"
                    value={formData[senderDetailRequirement.field] || ''}
                    onChange={(e) => handleInputChange(senderDetailRequirement.field, e.target.value)}
                    placeholder={senderDetailRequirement.placeholder}
                    className="min-w-0 flex-1 bg-transparent px-4 text-right font-['Poppins'] text-sm font-black text-rose-700 outline-none placeholder:font-semibold placeholder:text-[var(--color-text-secondary)] dark:text-rose-300 [font-variant-numeric:tabular-nums]"
                    disabled={isSubmitting}
                    required
                  />
                </div>
              ) : (
                <div
                  className="flex h-12 overflow-hidden rounded-xl border border-emerald-400/50 bg-emerald-50/40 shadow-inner shadow-black/5 transition focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-400/15 dark:bg-[linear-gradient(110deg,rgb(8_39_31/0.78),rgb(15_23_42/0.78))] dark:shadow-black/15"
                  dir={dir}
                >
                  <span className="grid min-w-16 shrink-0 place-items-center border-e border-emerald-600/45 bg-[linear-gradient(145deg,#34d399,#059669_58%,#047857)] text-white shadow-[0_0_24px_-12px_rgb(5_150_105/0.9)]">
                    <WalletCards className="h-5 w-5 drop-shadow-sm" />
                  </span>
                  <input
                    type="text"
                    value={formData[senderDetailRequirement.field] || ''}
                    onChange={(e) => handleInputChange(senderDetailRequirement.field, e.target.value)}
                    placeholder={senderDetailRequirement.placeholder}
                    className="min-w-0 flex-1 bg-transparent px-4 text-right text-sm font-bold text-emerald-800 outline-none placeholder:font-semibold placeholder:text-[var(--color-text-secondary)] dark:text-emerald-200"
                    disabled={isSubmitting}
                    required
                  />
                </div>
              )}
            </div>
          )}

          {needsTransactionNumber && (
          <div className="mb-4">
            <label className={`mb-1.5 flex items-center justify-between gap-2 text-xs font-black text-[var(--color-text)] ${isRTL ? 'text-right' : 'text-left'}`}>
              <span>رقم العملية</span>
              <FieldCompletionBadge complete={Boolean(String(formData.transactionId || '').trim())} />
            </label>
            <div
              className="flex h-12 overflow-hidden rounded-xl border border-indigo-400/55 bg-indigo-50/50 shadow-inner shadow-black/5 transition focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-400/15 dark:bg-[linear-gradient(110deg,rgb(30_27_75/0.78),rgb(8_47_73/0.72))] dark:shadow-black/15"
              dir={dir}
            >
              <span className="grid min-w-16 shrink-0 place-items-center border-e border-indigo-600/50 bg-[linear-gradient(145deg,#818cf8,#4f46e5_52%,#2563eb)] text-white shadow-[0_0_24px_-12px_rgb(79_70_229/0.9)]">
                <Hash className="h-5 w-5 drop-shadow-sm" />
              </span>
              <input
                type="text"
                value={formData.transactionId || ''}
                onChange={(e) => handleInputChange('transactionId', e.target.value)}
                placeholder="أدخل رقم العملية"
                className="min-w-0 flex-1 bg-transparent px-4 text-right font-['Poppins'] text-sm font-black tracking-wide text-indigo-700 outline-none placeholder:font-semibold placeholder:tracking-normal placeholder:text-[var(--color-text-secondary)] dark:text-indigo-200 [font-variant-numeric:tabular-nums]"
                disabled={isSubmitting}
                required
              />
            </div>
          </div>
          )}
          </div>

          {requiresReceipt && (
            <div className="mb-5 border-t border-[color:rgb(var(--color-border-rgb)/0.58)] pt-5">
              <label className={`mb-2.5 flex items-center justify-between gap-2 text-xs font-black text-[var(--color-text)] ${isRTL ? 'text-right' : 'text-left'}`}>
                <span>{t('payments.uploadReceipt')}</span>
                <FieldCompletionBadge complete={Boolean(uploadedFile)} />
              </label>
              <UploadReceiptBox
                onFileUpload={handleReceiptUpload}
                paymentAmount={formData.amount}
                transactionId={needsTransactionNumber ? formData.transactionId : ''}
                {...receiverDestination}
              />
            </div>
          )}

          <div className="mb-5 rounded-2xl border border-indigo-500/15 bg-[linear-gradient(135deg,rgb(6_182_212/0.07),rgb(79_70_229/0.08))] p-4">
            <div className="flex items-center justify-between gap-3 px-1 text-xs">
              <span className="font-bold text-[var(--color-text-secondary)]">
                {t('payments.subtotalLabel', {
                  defaultValue: dir === 'rtl' ? 'المبلغ الأساسي' : 'Base amount',
                })}
              </span>
              <span className="font-['Poppins'] font-extrabold tracking-tight text-[var(--color-text)] [direction:ltr] [font-variant-numeric:tabular-nums]">{formatMoney(baseAmount)}</span>
            </div>

            {feePercent > 0 && (
              <div className="mt-2 flex items-center justify-between gap-3 px-1 text-xs">
                <span className="font-bold text-[var(--color-text-secondary)]">
                  {t('payments.feeAmountLabel', {
                    defaultValue: dir === 'rtl' ? 'رسوم التحويل' : 'Payment fee',
                  })}
                  {` (${feePercent}%)`}
                </span>
                <span className="font-['Poppins'] font-extrabold tracking-tight text-amber-600 [direction:ltr] [font-variant-numeric:tabular-nums] dark:text-amber-300">{formatMoney(feeAmount)}</span>
              </div>
            )}

            <div className="mt-3 flex items-end justify-between gap-3 border-t border-indigo-500/15 px-1 pt-3 text-xs">
              <span className="font-black text-[var(--color-text)]">
                {t('payments.totalToTransferLabel', {
                  defaultValue: dir === 'rtl' ? 'الإجمالي المطلوب تحويله' : 'Total to transfer',
                })}
              </span>
              <span className="font-['Poppins'] text-lg font-black tracking-tight text-cyan-600 [direction:ltr] [font-variant-numeric:tabular-nums] dark:text-cyan-300">{formatMoney(payableAmount)}</span>
            </div>
          </div>

          {formError && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.24, ease: 'easeOut' }}
              className={`mb-4 rounded-[1rem] border border-rose-200 bg-rose-50/90 p-3.5 shadow-[0_14px_28px_-26px_rgba(225,29,72,0.55)] dark:border-rose-900/70 dark:bg-rose-950/25 ${isRTL ? 'text-right' : 'text-left'}`}
            >
              <div className={`flex items-start gap-3 ${isRTL ? 'flex-row-reverse' : ''}`}>
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[0.75rem] border border-rose-200 bg-white text-rose-600 dark:border-rose-900/70 dark:bg-slate-950 dark:text-rose-300">
                  <AlertCircle className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-black text-rose-700 dark:text-rose-200">
                    {dir === 'rtl' ? 'راجع بيانات الدفع' : 'Check payment details'}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-rose-700/85 dark:text-rose-100/80">{formError}</p>
                </div>
              </div>
            </motion.div>
          )}

          <motion.button
            type="submit"
            aria-busy={isSubmitting}
            whileTap={{ scale: 0.985 }}
            whileHover={!isSubmitting ? { y: -1 } : undefined}
            className="group flex h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-[linear-gradient(135deg,#0891b2_0%,#2563eb_55%,#4f46e5_100%)] px-5 text-sm font-black text-white shadow-[0_20px_38px_-22px_rgba(37,99,235,0.9)] transition hover:-translate-y-0.5 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-70"
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <>
                <Loader className="h-5 w-5 animate-spin" />
                <span>{t('common.processing')}</span>
              </>
            ) : (
              <>
                <CheckCircle className="h-5 w-5" />
                <span>{t('payments.confirmPayment')}</span>
              </>
            )}
          </motion.button>
        </motion.form>
        </div>

        {submitStatus === 'success' && createPortal(
          <div className="fixed inset-0 z-[240] flex items-center justify-center bg-[radial-gradient(34rem_circle_at_50%_15%,rgb(192_38_211/0.2),transparent_52%),radial-gradient(28rem_circle_at_15%_85%,rgb(37_99_235/0.17),transparent_50%),rgb(2_1_10/0.82)] px-4 backdrop-blur-[16px]">
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 14 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              transition={{ duration: 0.26, ease: 'easeOut' }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="topup-success-title"
              className="relative isolate w-full max-w-[21.5rem] overflow-hidden rounded-[1.65rem] border border-cyan-300/25 bg-[radial-gradient(20rem_circle_at_92%_-8%,rgb(244_114_208/0.25),transparent_46%),radial-gradient(18rem_circle_at_2%_104%,rgb(37_99_235/0.3),transparent_48%),linear-gradient(145deg,#10082b_0%,#221b53_52%,#42136a_100%)] p-5 text-center text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_32px_90px_-35px_rgb(0_0_0/0.95),0_0_55px_-28px_rgb(192_38_211/0.76),0_0_50px_-30px_rgb(124_58_237/0.88)] sm:p-6"
            >
              <div className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(90deg,rgb(255_255_255/0.025)_1px,transparent_1px),linear-gradient(180deg,rgb(255_255_255/0.025)_1px,transparent_1px)] bg-[length:30px_30px] [mask-image:linear-gradient(180deg,black,transparent_90%)]" />
              <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl border border-emerald-300/25 bg-[linear-gradient(145deg,rgb(52_211_153/0.22),rgb(20_184_166/0.1))] text-emerald-300 shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_18px_42px_-22px_rgb(52_211_153/0.9)]">
                <CheckCircle className="h-8 w-8" />
              </div>
              <h3 id="topup-success-title" className="text-xl font-black tracking-tight text-white">
                {dir === 'rtl' ? 'تم الشحن' : 'Top-up submitted'}
              </h3>
              <p className="mx-auto mt-2 max-w-[17rem] text-xs font-semibold leading-6 text-cyan-100/76">
                {dir === 'rtl'
                  ? 'تم إرسال طلب إضافة الرصيد للمراجعة.'
                  : 'Your balance top-up request was sent for review.'}
              </p>

              <div className="mt-5 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleSuccessConfirm}
                  className="h-11 rounded-xl bg-[linear-gradient(135deg,#087f9b,#b37a18)] px-3 text-xs font-black text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.16),0_16px_32px_-20px_rgb(192_38_211/0.9)] transition hover:-translate-y-0.5 hover:brightness-110"
                >
                  {dir === 'rtl' ? 'سجل الطلبات' : 'Request history'}
                </button>
                <button
                  type="button"
                  onClick={handleSuccessCancel}
                  className="h-11 rounded-xl border border-white/15 bg-white/8 px-3 text-xs font-black text-cyan-100 backdrop-blur-md transition hover:border-white/28 hover:bg-white/14 hover:text-white"
                >
                  {onReturnToPurchase
                    ? (dir === 'rtl' ? 'العودة للشراء' : 'Back to purchase')
                    : (dir === 'rtl' ? 'إلغاء' : 'Cancel')}
                </button>
              </div>
            </motion.div>
          </div>,
          document.body
        )}

        {submitStatus === 'error' && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.24, ease: 'easeOut' }}
            className={`rounded-[1.2rem] border border-rose-200 bg-white/90 p-4 shadow-[0_18px_34px_-30px_rgba(225,29,72,0.45)] backdrop-blur-xl dark:border-rose-900/70 dark:bg-slate-950/78 ${isRTL ? 'text-right' : 'text-left'}`}
          >
            <div className={`flex items-start gap-3 ${isRTL ? 'flex-row-reverse' : ''}`}>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[0.9rem] border border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-900/70 dark:bg-rose-950/35 dark:text-rose-300">
                <AlertCircle className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h3 className="text-base font-black text-slate-950 dark:text-white">{t('payments.submitErrorTitle')}</h3>
                <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">{t('payments.submitErrorDesc')}</p>
              </div>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
};

export default PaymentDetails;

