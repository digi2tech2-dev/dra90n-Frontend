import React, { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Check, CheckCircle2, Clock3, Eye, Pencil, Search, Wallet, X } from 'lucide-react';
import useTopupStore from '../../store/useTopupStore';
import useAuthStore from '../../store/useAuthStore';
import useAdminStore from '../../store/useAdminStore';
import useSystemStore from '../../store/useSystemStore';
import Card from '../../components/ui/Card';
import Input from '../../components/ui/Input';
import Button from '../../components/ui/Button';
import Badge from '../../components/ui/Badge';
import Modal from '../../components/ui/Modal';
import RejectionReasonModal from '../../components/target/RejectionReasonModal';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { formatDateTime, formatNumber } from '../../utils/intl';
import { PERMISSIONS, hasPermission } from '../../utils/permissions';
import { findPaymentMethodById } from '../../utils/paymentSettings';

const normalizeStatus = (status) => String(status || '').trim().toLowerCase();

const statusVariant = (status) => {
  const value = normalizeStatus(status);
  if (value === 'approved' || value === 'completed') return 'success';
  if (value === 'rejected' || value === 'denied') return 'danger';
  return 'warning';
};

const isPendingLike = (status) => ['pending', 'requested', 'processing', 'under_review'].includes(normalizeStatus(status));

const statusLabel = (status) => {
  const value = normalizeStatus(status);
  if (value === 'approved' || value === 'completed') return 'معتمد';
  if (value === 'rejected' || value === 'denied') return 'مرفوض';
  if (value === 'processing') return 'قيد التنفيذ';
  if (value === 'under_review' || value === 'requested' || value === 'pending') return 'قيد الانتظار';
  return status || '-';
};

const getRequestId = (request) => String(
  request?.reference
  || request?.referenceId
  || request?.depositNumber
  || request?.topupNumber
  || request?.id
  || request?._id
  || ''
).trim();

const getPaymentChannelLabel = (request) => {
  if (request?.paymentChannel === 'bank_transfer') return 'تحويل بنكي';
  return request?.paymentChannelName || request?.method || 'محفظة كاش';
};

/** تحويل رمز الدولة (مثل EG) إلى emoji علم */
const countryCodeToFlag = (code) => {
  if (!code || code.length < 2) return '';
  return [...String(code).toUpperCase().slice(0, 2)]
    .map((c) => String.fromCodePoint(0x1f1e0 + c.charCodeAt(0) - 65))
    .join('');
};

/** معلومات الدولة + مجموعة الدفع + العملة */
const getCountryGroupInfo = (request, paymentSettings) => {
  const matchedPayment = findPaymentMethodById(paymentSettings, request?.paymentMethodId, { fallbackToDefault: false });
  const group = matchedPayment?.group;
  const currencyCode = String(request?.currencyCode || request?.currency || group?.currency || '').trim().toUpperCase();
  const fallbackCountryCode = { EGP: 'EG', SAR: 'SA', AED: 'AE', KWD: 'KW', QAR: 'QA', USD: 'US' }[currencyCode] || '';
  const flag = countryCodeToFlag(request?.transferCountryCode || fallbackCountryCode);
  const countryName = String(request?.transferCountryName || '').trim();
  const groupName = String(
    request?.paymentMethodGroupName
    || request?.paymentGroupName
    || group?.name
    || request?.paymentChannelName
    || (request?.paymentChannel === 'bank_transfer' ? 'تحويل بنكي' : '')
    || request?.method
    || ''
  ).trim();
  return { flag, countryName, groupName, currencyCode };
};

const getSenderDetails = (request) => {
  const details = request?.senderDetails && typeof request.senderDetails === 'object'
    ? request.senderDetails
    : {};
  const value = String(
    details.value
    || request?.senderWalletAddress
    || request?.senderWalletNumber
    || request?.transferredFromNumber
    || ''
  ).trim();
  const methodType = String(details.methodType || details.type || request?.paymentMethodType || '').trim().toLowerCase();
  const field = String(details.field || (request?.senderWalletAddress ? 'senderWalletAddress' : 'senderWalletNumber')).trim();
  const label = String(
    details.label
    || (field === 'senderWalletAddress' || methodType === 'usdt'
      ? 'عنوان المحفظة المحول منها'
      : 'رقم المحفظة المحول منها')
  ).trim();
  const transactionNumber = String(
    details.transactionNumber
    || details.transactionId
    || details.paymentReference
    || request?.transactionNumber
    || request?.transactionId
    || request?.paymentReference
    || request?.operationNumber
    || request?.operationId
    || request?.referenceNumber
    || request?.transferNumber
    || request?.transferReference
    || request?.transaction?.number
    || request?.transaction?.id
    || ''
  ).trim();

  return { label, value: value || '-', transactionNumber };
};

const PAGE_SIZE = 20;

const SummaryCard = ({ icon: Icon, label, value }) => (
  <Card className="admin-premium-stat p-2.5">
    <div className="flex items-start gap-2">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[0.8rem] border border-[color:rgb(var(--color-primary-rgb)/0.18)] bg-[color:rgb(var(--color-primary-rgb)/0.08)] text-[var(--color-primary)]">
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] text-[var(--color-text-secondary)]">{label}</p>
        <p className="mt-0.5 text-lg font-semibold text-[var(--color-text)]">{value}</p>
      </div>
    </div>
  </Card>
);

const AdminPayments = () => {
  const { topups, topupsPagination, topupsSummary, loadTopups, loadTopupsFiltered, getTopupById, updateTopupStatus, updateTopupRequest } = useTopupStore();
  const { user: actor } = useAuthStore();
  const { users, loadUsers } = useAdminStore();
  const { currencies, loadCurrencies, paymentSettings, loadPaymentSettings } = useSystemStore();
  const { addToast } = useToast();
  const canConfirmPayments = hasPermission(actor, PERMISSIONS.ADMIN_PAYMENTS);

  // ── Filter state ────────────────────────────────────────────────────────
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const deferredSearch = useDeferredValue(searchTerm);
  const normalizedSearch = useMemo(
    () => String(deferredSearch || '').trim().replace(/^#/, ''),
    [deferredSearch]
  );
  const [summarySnapshot, setSummarySnapshot] = useState(null);

  const [isReviewModalOpen, setIsReviewModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [reviewForm, setReviewForm] = useState({
    actualPaidAmount: '',
    currencyCode: 'USD',
    adminNote: '',
  });
  const [editForm, setEditForm] = useState({
    requestedAmount: '',
    adminNote: '',
  });
  const [receiptPreviewUrl, setReceiptPreviewUrl] = useState(null);
  const [isReceiptModalOpen, setIsReceiptModalOpen] = useState(false);
  const [rejectingRequest, setRejectingRequest] = useState(null);

  // ── Fetch deposits with filters ─────────────────────────────────────────
  const fetchDeposits = useCallback(async () => {
    setIsLoading(true);
    try {
      await loadTopupsFiltered({
        page: currentPage,
        limit: PAGE_SIZE,
        status: statusFilter,
        search: normalizedSearch,
      });
    } catch (_err) {
      // fallback — loadTopups without filters
      await loadTopups({ force: true });
    }
    setIsLoading(false);
  }, [currentPage, statusFilter, normalizedSearch, loadTopupsFiltered, loadTopups]);

  useEffect(() => {
    fetchDeposits();
    loadUsers({ force: true });
    loadCurrencies();
    loadPaymentSettings({ force: true });
  }, [fetchDeposits, loadUsers, loadCurrencies, loadPaymentSettings]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [normalizedSearch, statusFilter]);

  const requests = useMemo(
    () => [...(topups || [])],
    [topups]
  );

  useEffect(() => {
    if (normalizedSearch || statusFilter !== 'all') return;

    setSummarySnapshot({
      totalDeposits: topupsSummary?.totalDeposits ?? topupsPagination?.total ?? requests.length,
      pendingCount: topupsSummary?.pendingCount
        ?? requests.filter((request) => isPendingLike(request.status)).length,
      approvedCount: topupsSummary?.approvedCount
        ?? requests.filter((request) => ['approved', 'completed'].includes(normalizeStatus(request.status))).length,
      rejectedCount: topupsSummary?.rejectedCount
        ?? topupsSummary?.deniedCount
        ?? requests.filter((request) => ['rejected', 'denied'].includes(normalizeStatus(request.status))).length,
    });
  }, [normalizedSearch, requests, statusFilter, topupsPagination?.total, topupsSummary]);

  const openApproveModal = async (request) => {
    let nextRequest = request;

    try {
      nextRequest = await getTopupById(request.id) || request;
    } catch (_error) {
      nextRequest = request;
    }

    setSelectedRequest(nextRequest);
    setReviewForm({
      actualPaidAmount: String(nextRequest?.requestedAmount ?? nextRequest?.requestedCoins ?? nextRequest?.amount ?? 0),
      currencyCode: nextRequest?.currencyCode || nextRequest?.currency || 'USD',
      adminNote: '',
    });
    setIsReviewModalOpen(true);
  };

  const openEditModal = async (request) => {
    let nextRequest = request;

    try {
      nextRequest = await getTopupById(request.id) || request;
    } catch (_error) {
      nextRequest = request;
    }

    setSelectedRequest(nextRequest);
    setEditForm({
      requestedAmount: String(nextRequest?.requestedAmount ?? nextRequest?.requestedCoins ?? nextRequest?.amount ?? 0),
      adminNote: nextRequest?.adminNote || '',
    });
    setIsEditModalOpen(true);
  };

  const handleApprove = async () => {
    if (!canConfirmPayments) {
      addToast('ليس لديك صلاحية اعتماد طلبات الشحن.', 'error');
      return;
    }
    if (!selectedRequest) return;
    const actual = Number(reviewForm.actualPaidAmount || 0);
    if (actual <= 0) {
      addToast('أدخل المبلغ الفعلي المدفوع', 'error');
      return;
    }

    try {
      await updateTopupStatus(selectedRequest.id, 'approved', {
        actualPaidAmount: actual,
        currencyCode: reviewForm.currencyCode,
        adminNote: reviewForm.adminNote,
      });

      const requested = Number(selectedRequest.requestedAmount ?? selectedRequest.requestedCoins ?? selectedRequest.amount ?? 0);
      if (requested !== actual) {
        addToast('تم اعتماد الطلب بالمبلغ الفعلي فقط وإشعار المستخدم', 'info');
      } else {
        addToast('تم اعتماد الطلب بنجاح', 'success');
      }

      setIsReviewModalOpen(false);
      setSelectedRequest(null);
    } catch (error) {
      addToast(error?.message || 'فشل اعتماد الطلب', 'error');
    }
  };

  const handleReject = async (request) => {
    if (!canConfirmPayments) {
      addToast('ليس لديك صلاحية رفض طلبات الشحن.', 'error');
      return;
    }
    setRejectingRequest(request);
  };

  const confirmReject = async (note) => {
    if (!rejectingRequest?.id) return;

    try {
      await updateTopupStatus(rejectingRequest.id, 'rejected', {
        adminNote: String(note || '').trim(),
      });
      setRejectingRequest(null);
      addToast('تم رفض الطلب', 'info');
    } catch (error) {
      addToast(error?.message || 'فشل رفض الطلب', 'error');
    }
  };

  const handleEditRequest = async () => {
    if (!selectedRequest) return;
    const nextAmount = Number(editForm.requestedAmount || 0);
    if (nextAmount <= 0) {
      addToast('أدخل مبلغًا صحيحًا للتعديل', 'error');
      return;
    }

    try {
      await updateTopupRequest(selectedRequest.id, {
        requestedAmount: nextAmount,
        adminNote: editForm.adminNote,
      });
      addToast('تم تعديل مبلغ الطلب بنجاح', 'success');
      setIsEditModalOpen(false);
      setSelectedRequest(null);
    } catch (error) {
      addToast(error?.message || 'فشل تعديل الطلب', 'error');
    }
  };

  const findUserCurrency = (userId) => users.find((u) => u.id === userId)?.currency || 'USD';
  const formatRequestDate = (value) => formatDateTime(value, 'ar-EG', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const formatRequestAmount = (value) => formatNumber(value, 'ar-EG');

  const pagination = topupsPagination;
  const totalPages = pagination?.pages || 1;
  // Use server-side summary stats (unfiltered) so dashboard cards stay stable
  const hasActiveFilter = Boolean(normalizedSearch) || statusFilter !== 'all';
  const summarySource = hasActiveFilter && summarySnapshot ? summarySnapshot : topupsSummary;
  const totalDeposits = summarySource?.totalDeposits ?? pagination?.total ?? requests.length;
  const pendingCount = summarySource?.pendingCount
    ?? requests.filter((request) => isPendingLike(request.status)).length;
  const approvedCount = summarySource?.approvedCount
    ?? requests.filter((request) => ['approved', 'completed'].includes(normalizeStatus(request.status))).length;
  const rejectedCount = summarySource?.rejectedCount
    ?? summarySource?.deniedCount
    ?? requests.filter((request) => ['rejected', 'denied'].includes(normalizeStatus(request.status))).length;
  const selectedSenderDetails = useMemo(
    () => getSenderDetails(selectedRequest),
    [selectedRequest]
  );

  return (
    <div className="min-w-0 space-y-4 pb-4 sm:space-y-5">
      <section className="admin-premium-hero relative overflow-hidden p-3">
        <div className="pointer-events-none absolute -top-20 right-8 h-40 w-40 rounded-full bg-[color:rgb(var(--color-primary-rgb)/0.18)] blur-3xl" />
        <div className="pointer-events-none absolute bottom-0 left-0 h-28 w-28 rounded-full bg-[color:rgb(var(--color-primary-rgb)/0.12)] blur-3xl" />

        <div className="relative min-w-0">
          <h1 className="page-heading max-w-3xl">عمليات الشحن</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            مراجعة طلبات الشحن اليدوي وإدارة بيانات الاستلام وطرق الدفع من مكان واحد.
          </p>
        </div>

        <div className="relative mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
          <SummaryCard icon={Wallet} label="إجمالي الطلبات" value={formatRequestAmount(totalDeposits)} />
          <SummaryCard icon={Clock3} label="قيد الانتظار" value={formatRequestAmount(pendingCount)} />
          <SummaryCard icon={CheckCircle2} label="معتمدة" value={formatRequestAmount(approvedCount)} />
          <SummaryCard icon={X} label="مرفوضة" value={formatRequestAmount(rejectedCount)} />
        </div>
      </section>

      {/* Filter Toolbar */}
      <Card className="admin-premium-panel min-w-0 p-3 sm:p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-secondary)]" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="ابحث برقم الطلب أو اسم المستخدم أو البريد الإلكتروني..."
              className="w-full rounded-xl border border-[color:rgb(var(--color-border-rgb)/0.85)] bg-[var(--color-surface)] py-2.5 ps-10 pe-3 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-secondary)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
            />
          </div>
          <div className="flex items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-xl border border-[color:rgb(var(--color-border-rgb)/0.85)] bg-[var(--color-surface)] px-3 py-2.5 text-sm text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
            >
              <option value="all">الكل</option>
              <option value="PENDING">قيد الانتظار</option>
              <option value="APPROVED">معتمدة</option>
              <option value="REJECTED">مرفوضة</option>
            </select>
            <span className="whitespace-nowrap text-xs text-[var(--color-text-secondary)]">
              {formatRequestAmount(totalDeposits)} نتيجة
            </span>
          </div>
        </div>
      </Card>

      <Card className="admin-premium-panel min-w-0 p-4 sm:p-5">
        <h2 className="mb-4 text-lg font-semibold text-[var(--color-text)]">طلبات الشحن</h2>

        <div className="space-y-2.5 lg:hidden">
          {requests.map((request) => {
            const requestId = getRequestId(request);
            const currencyCode = request.currencyCode || findUserCurrency(request.userId);
            const requestedAmount = formatRequestAmount(request.requestedAmount ?? request.requestedCoins ?? request.amount ?? 0);
            const actualAmount = request.actualPaidAmount ? formatRequestAmount(request.actualPaidAmount) : '-';
            const senderDetails = getSenderDetails(request);

            return (
            <article
              key={request.id}
              className="rounded-[1rem] border border-[color:rgb(var(--color-border-rgb)/0.72)] bg-[color:rgb(var(--color-card-rgb)/0.94)] p-3 shadow-[0_14px_28px_-24px_rgba(15,23,42,0.26)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded-lg border border-[color:rgb(var(--color-border-rgb)/0.78)] bg-[color:rgb(var(--color-surface-rgb)/0.7)] px-2 py-0.5 text-[10px] font-bold text-[var(--color-text-secondary)]">
                      #{requestId || '-'}
                    </span>
                    <Badge variant={statusVariant(request.status)}>{statusLabel(request.status)}</Badge>
                  </div>
                  <p className="mt-2 truncate text-sm font-bold text-[var(--color-text)]">{request.userName || request.userId}</p>
                  <p className="mt-0.5 text-[11px] text-[var(--color-text-secondary)]">{request.userEmail || request.userId}</p>
                </div>
                <div className="shrink-0 text-left" dir="ltr">
                  <p className="text-base font-black text-[var(--color-text)]">{requestedAmount}</p>
                  <p className="text-[10px] font-semibold text-[var(--color-text-secondary)]">{currencyCode}</p>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                <div className="rounded-lg bg-[color:rgb(var(--color-surface-rgb)/0.62)] px-2 py-1.5">
                  <p className="text-[var(--color-text-secondary)]">التاريخ</p>
                  <p className="mt-0.5 font-semibold text-[var(--color-text)]">{formatRequestDate(request.createdAt || Date.now())}</p>
                </div>
                <div className="rounded-lg bg-[color:rgb(var(--color-surface-rgb)/0.62)] px-2 py-1.5">
                  <p className="text-[var(--color-text-secondary)]">قناة الدفع</p>
                  <p className="mt-0.5 font-semibold text-[var(--color-text)]">{getPaymentChannelLabel(request)}</p>
                </div>
                <div className="rounded-lg bg-[color:rgb(var(--color-surface-rgb)/0.62)] px-2 py-1.5">
                  <p className="text-[var(--color-text-secondary)]">رقم العملية</p>
                  <p className="mt-0.5 break-all font-bold text-[var(--color-primary)]">
                    {senderDetails.transactionNumber || '-'}
                  </p>
                </div>
                <div className="rounded-lg bg-[color:rgb(var(--color-surface-rgb)/0.62)] px-2 py-1.5">
                  <p className="text-[var(--color-text-secondary)]">المبلغ الفعلي</p>
                  <p className="mt-0.5 font-semibold text-[var(--color-text)]">{actualAmount}</p>
                </div>
                {(() => {
                  const cgi = getCountryGroupInfo(request, paymentSettings);
                  return (
                    <div className="rounded-lg bg-[color:rgb(var(--color-surface-rgb)/0.62)] px-2 py-1.5">
                      <p className="text-[var(--color-text-secondary)]">مجموعة الدفع / العملة</p>
                      <p className="mt-0.5 font-semibold text-[var(--color-text)]">
                        {cgi.flag ? <span className="me-1">{cgi.flag}</span> : null}
                        {cgi.groupName || cgi.countryName || '-'}
                      </p>
                      {cgi.currencyCode ? (
                        <p className="mt-0.5 text-[10px] text-[var(--color-text-secondary)]">{cgi.currencyCode}</p>
                      ) : null}
                    </div>
                  );
                })()}
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                {request.proofImage ? (
                  <button
                    type="button"
                    onClick={() => { setReceiptPreviewUrl(request.proofImage); setIsReceiptModalOpen(true); }}
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-[color:rgb(var(--color-primary-rgb)/0.25)] px-2.5 text-xs font-semibold text-[var(--color-primary)] hover:bg-[color:rgb(var(--color-primary-rgb)/0.08)]"
                  >
                    <Eye className="h-3.5 w-3.5" /> عرض الإيصال
                  </button>
                ) : (
                  <span className="text-xs text-[var(--color-text-secondary)]">لا يوجد إيصال</span>
                )}
                <div className="flex flex-wrap gap-1.5">
                {isPendingLike(request.status) && canConfirmPayments ? (
                  <>
                    <Button size="sm" variant="outline" onClick={() => openEditModal(request)}>
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button size="sm" onClick={() => openApproveModal(request)} className="bg-green-600 hover:bg-green-700">
                      <Check className="w-4 h-4" />
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => handleReject(request)}>
                      <X className="w-4 h-4" />
                    </Button>
                  </>
                ) : (
                  <span className="text-xs text-gray-400">تمت المراجعة</span>
                )}
                </div>
              </div>
            </article>
            );
          })}
        </div>

        <div className="hidden lg:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>رقم الطلب</TableHead>
                <TableHead>التاريخ</TableHead>
                <TableHead>المستخدم</TableHead>
                <TableHead className="text-center">الدولة</TableHead>
                <TableHead className="text-center">قناة الدفع</TableHead>
                <TableHead className="text-center">العملة</TableHead>
                <TableHead className="text-center">المبلغ المطلوب</TableHead>
                <TableHead className="text-center">المبلغ الفعلي</TableHead>
                <TableHead className="text-center">رقم العملية</TableHead>
                <TableHead className="text-center">الإيصال</TableHead>
                <TableHead className="text-center">الحالة</TableHead>
                <TableHead className="text-end">الإجراءات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((request) => {
                const requestId = getRequestId(request);
                const currencyCode = request.currencyCode || findUserCurrency(request.userId);
                const senderDetails = getSenderDetails(request);

                return (
                <TableRow key={request.id}>
                  <TableCell>
                    <span className="inline-flex rounded-lg border border-[color:rgb(var(--color-border-rgb)/0.8)] bg-[color:rgb(var(--color-surface-rgb)/0.7)] px-2 py-1 text-xs font-bold text-[var(--color-text)]">
                      #{requestId || '-'}
                    </span>
                  </TableCell>
                  <TableCell>{formatRequestDate(request.createdAt || Date.now())}</TableCell>
                  <TableCell>
                    <div className="font-medium text-gray-900 dark:text-white">{request.userName || request.userId}</div>
                    <div className="text-xs text-gray-500">{request.userEmail || request.userId}</div>
                  </TableCell>
                  <TableCell className="text-center">
                    {(() => {
                      const cgi = getCountryGroupInfo(request, paymentSettings);
                      return (
                        <>
                          {cgi.flag ? <span className="me-1 text-base">{cgi.flag}</span> : null}
                          <span className="font-medium">{cgi.groupName || cgi.countryName || '-'}</span>
                          {cgi.currencyCode ? <div className="text-xs text-gray-500">{cgi.currencyCode}</div> : null}
                        </>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="text-center">{getPaymentChannelLabel(request)}</TableCell>
                  <TableCell className="text-center font-semibold">{currencyCode}</TableCell>
                  <TableCell className="text-center">{formatRequestAmount(request.requestedAmount ?? request.requestedCoins ?? request.amount ?? 0)}</TableCell>
                  <TableCell className="text-center">{request.actualPaidAmount ? formatRequestAmount(request.actualPaidAmount) : '-'}</TableCell>
                  <TableCell className="max-w-[220px] text-center">
                    <div className="break-all font-bold text-[var(--color-primary)]">{senderDetails.transactionNumber || '-'}</div>
                  </TableCell>
                  <TableCell className="text-center">
                    {request.proofImage ? (
                      <button
                        type="button"
                        onClick={() => { setReceiptPreviewUrl(request.proofImage); setIsReceiptModalOpen(true); }}
                        className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-700"
                      >
                        <Eye className="w-4 h-4" /> عرض
                      </button>
                    ) : (
                      <span className="text-xs text-gray-400">لا يوجد</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant={statusVariant(request.status)}>{statusLabel(request.status)}</Badge>
                  </TableCell>
                  <TableCell className="text-end">
                    {isPendingLike(request.status) && canConfirmPayments ? (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => openEditModal(request)}>
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button size="sm" onClick={() => openApproveModal(request)} className="bg-green-600 hover:bg-green-700">
                          <Check className="w-4 h-4" />
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => handleReject(request)}>
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">تمت المراجعة</span>
                    )}
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {/* Empty state */}
        {!isLoading && requests.length === 0 && (
          <div className="rounded-xl border border-dashed border-[color:rgb(var(--color-border-rgb)/0.85)] bg-[color:rgb(var(--color-surface-rgb)/0.7)] p-8 text-center">
            <p className="text-sm text-[var(--color-text-secondary)]">
              {searchTerm || statusFilter !== 'all'
                ? 'لم يتم العثور على طلبات مطابقة. جرّب تعديل البحث أو الفلاتر.'
                : 'لا توجد طلبات شحن بعد.'}
            </p>
          </div>
        )}
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage <= 1}
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
          >
            السابق
          </Button>
          <span className="text-sm text-[var(--color-text-secondary)]">
            صفحة {formatRequestAmount(currentPage)} من {formatRequestAmount(totalPages)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage >= totalPages}
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
          >
            التالي
          </Button>
        </div>
      )}

      <Modal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        title="تعديل المبلغ المطلوب"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setIsEditModalOpen(false)}>إلغاء</Button>
            <Button onClick={handleEditRequest}>تعديل</Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            تعديل قيمة الطلب للعميل: <strong>{selectedRequest?.userName}</strong>
          </p>
          <Input
            label="المبلغ المطلوب بعد التعديل"
            type="number"
            min="0"
            step="0.01"
            value={editForm.requestedAmount}
            onChange={(e) => setEditForm((prev) => ({ ...prev, requestedAmount: e.target.value }))}
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">ملاحظة التعديل (اختياري)</label>
            <textarea
              rows={3}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              value={editForm.adminNote}
              onChange={(e) => setEditForm((prev) => ({ ...prev, adminNote: e.target.value }))}
            />
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={isReviewModalOpen}
        onClose={() => setIsReviewModalOpen(false)}
        title="اعتماد طلب الشحن"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setIsReviewModalOpen(false)}>إلغاء</Button>
            <Button onClick={handleApprove}>اعتماد</Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            اسم العميل: <strong>{selectedRequest?.userName}</strong>
          </p>

          <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            <p className="mb-1 text-sm font-medium text-gray-800 dark:text-gray-100">{selectedSenderDetails.label}</p>
            <p className="break-all text-sm text-gray-600 dark:text-gray-300">{selectedSenderDetails.value}</p>
          </div>

          <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100 mb-2">الإيصال المرفوع</p>
            {selectedRequest?.proofImage ? (
              <>
                <img
                  src={selectedRequest.proofImage}
                  alt="Payment proof"
                  className="mx-auto max-h-40 w-auto max-w-full rounded-lg object-contain bg-gray-50 dark:bg-gray-900"
                />
                <a
                  href={selectedRequest.proofImage}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex mt-2 text-sm text-indigo-600 hover:text-indigo-700"
                >
                  فتح الصورة بحجم كامل
                </a>
              </>
            ) : (
              <p className="text-xs text-gray-500">لم يرفع العميل صورة إيصال.</p>
            )}
          </div>

          <Input
            label="المبلغ الفعلي المدفوع"
            type="number"
            min="0"
            step="0.01"
            value={reviewForm.actualPaidAmount}
            onChange={(e) => setReviewForm((prev) => ({ ...prev, actualPaidAmount: e.target.value }))}
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">العملة</label>
            <select
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:bg-gray-800 dark:border-gray-700"
              value={reviewForm.currencyCode}
              onChange={(e) => setReviewForm((prev) => ({ ...prev, currencyCode: e.target.value }))}
            >
              {(currencies || []).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} - {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">ملاحظة للإشعار (اختياري)</label>
            <textarea
              rows={3}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              value={reviewForm.adminNote}
              onChange={(e) => setReviewForm((prev) => ({ ...prev, adminNote: e.target.value }))}
            />
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={isReceiptModalOpen}
        onClose={() => { setIsReceiptModalOpen(false); setReceiptPreviewUrl(null); }}
        title="عرض الإيصال"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => { setIsReceiptModalOpen(false); setReceiptPreviewUrl(null); }}>إغلاق</Button>
            {receiptPreviewUrl && (
              <a href={receiptPreviewUrl} target="_blank" rel="noreferrer">
                <Button>فتح بحجم كامل</Button>
              </a>
            )}
          </div>
        }
      >
        {receiptPreviewUrl ? (
          <img
            src={receiptPreviewUrl}
            alt="Payment receipt"
            className="mx-auto max-h-[56vh] w-auto max-w-full rounded-lg object-contain bg-gray-50 dark:bg-gray-900"
          />
        ) : (
          <p className="text-sm text-gray-500">لا توجد صورة إيصال.</p>
        )}
      </Modal>

      <RejectionReasonModal
        isOpen={Boolean(rejectingRequest)}
        onClose={() => setRejectingRequest(null)}
        onConfirm={confirmReject}
        title="رفض طلب الشحن"
        description="سبب الرفض اختياري، وسيظهر للمستخدم داخل تفاصيل الطلب لو كتبته."
        confirmLabel="رفض الطلب"
      />
    </div>
  );
};

export default AdminPayments;

