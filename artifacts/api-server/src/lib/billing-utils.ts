/** Monto efectivo: abonos suman, devoluciones restan. */
export function signedPaymentAmount(amount: number, paymentType: string): number {
  return paymentType === "devolucion" ? -Math.abs(amount) : Math.abs(amount);
}

export function computeBalance(quotationTotal: number, paidAmount: number): number {
  return Math.max(0, quotationTotal - paidAmount);
}

type PaymentLike = {
  quotationId?: number | null;
  treatmentName?: string | null;
  concept?: string | null;
  expectedTotal?: number | null;
  amount: number;
  paymentType: string;
};

type QuoteItemLike = {
  service: string;
  price: number;
  quantity?: number;
};

/** Presupuesto activo = el del abono más reciente vinculado a facturación. */
export function detectActiveQuotationId(payments: PaymentLike[]): number | null {
  for (const p of payments) {
    if (p.quotationId) return p.quotationId;
  }
  return null;
}

/** Reparte abonos del presupuesto entre líneas (nombre exacto + excedente FIFO). */
export function buildQuotationItemBalances(
  items: QuoteItemLike[],
  quoteId: number,
  quotePaid: number,
  payments: PaymentLike[],
): {
  service: string;
  price: number;
  quantity: number;
  lineTotal: number;
  paid: number;
  balance: number;
}[] {
  const quotePayments = payments.filter((p) => p.quotationId === quoteId);
  const lines = items.map((item) => {
    const quantity = item.quantity ?? 1;
    const lineTotal = Math.round(item.price * quantity);
    const key = item.service.toLowerCase();
    const matchedPaid = quotePayments
      .filter((p) => p.treatmentName?.toLowerCase() === key)
      .reduce((s, p) => s + signedPaymentAmount(p.amount, p.paymentType), 0);
    return {
      service: item.service,
      price: item.price,
      quantity,
      lineTotal,
      paid: Math.max(0, matchedPaid),
      balance: 0,
    };
  });

  const matchedSum = lines.reduce((s, l) => s + l.paid, 0);
  let unallocated = Math.max(0, quotePaid - matchedSum);

  for (const line of lines) {
    if (unallocated <= 0) break;
    const room = Math.max(0, line.lineTotal - line.paid);
    if (room <= 0) continue;
    const extra = Math.min(room, unallocated);
    line.paid += extra;
    unallocated -= extra;
  }

  for (const line of lines) {
    line.balance = computeBalance(line.lineTotal, line.paid);
  }

  return lines;
}

/** Deuda de tratamientos sin presupuesto vinculado. */
export function computeStandaloneTreatmentDebts(
  payments: PaymentLike[],
  patientTreatmentPrice?: number | null,
): { totalOwed: number; remaining: number; totalPaid: number } {
  const standalonePayments = payments.filter((p) => !p.quotationId);
  const totalPaid = standalonePayments.reduce(
    (s, p) => s + signedPaymentAmount(p.amount, p.paymentType),
    0,
  );

  const expectedByTreatment = new Map<string, number>();

  for (const p of standalonePayments) {
    const key = (p.treatmentName || p.concept || "tratamiento").toLowerCase().trim();
    if (p.expectedTotal != null && p.expectedTotal > 0) {
      expectedByTreatment.set(key, Math.max(expectedByTreatment.get(key) ?? 0, p.expectedTotal));
    }
  }

  if (expectedByTreatment.size === 0 && patientTreatmentPrice != null && patientTreatmentPrice > 0) {
    expectedByTreatment.set("plan de tratamiento", patientTreatmentPrice);
  }

  let totalOwed = 0;
  let remaining = 0;

  for (const [key, expected] of expectedByTreatment) {
    const paid = standalonePayments
      .filter((p) => {
        const pKey = (p.treatmentName || p.concept || "tratamiento").toLowerCase().trim();
        return pKey === key;
      })
      .reduce((s, p) => s + signedPaymentAmount(p.amount, p.paymentType), 0);
    totalOwed += expected;
    remaining += computeBalance(expected, paid);
  }

  return { totalOwed, remaining, totalPaid };
}

export function summarizePatientBilling(
  quotes: { id: number; total: number; items: QuoteItemLike[] }[],
  payments: PaymentLike[],
  paidByQuotation: Map<number, number>,
  patientTreatmentPrice?: number | null,
  scopeQuotationId?: number | null,
): {
  totalPaid: number;
  totalOwed: number;
  remainingDebt: number;
  totalDebt: number;
  activeQuotationId: number | null;
  quotationsWithBalance: {
    id: number;
    total: number;
    paid: number;
    balance: number;
    items: ReturnType<typeof buildQuotationItemBalances>;
  }[];
} {
  const quotationsWithBalance = quotes.map((q) => {
    const paid = paidByQuotation.get(q.id) ?? 0;
    const items = buildQuotationItemBalances(q.items, q.id, paid, payments);
    return {
      id: q.id,
      total: q.total,
      paid,
      balance: computeBalance(q.total, paid),
      items,
    };
  });

  const activeQuotationId =
    scopeQuotationId !== undefined ? scopeQuotationId : detectActiveQuotationId(payments);

  let totalPaid: number;
  let totalOwed: number;
  let remainingDebt: number;

  if (activeQuotationId != null) {
    const q = quotationsWithBalance.find((x) => x.id === activeQuotationId);
    totalPaid = q?.paid ?? 0;
    totalOwed = q?.total ?? 0;
    remainingDebt = q?.balance ?? 0;
  } else {
    const standalone = computeStandaloneTreatmentDebts(payments, patientTreatmentPrice);
    totalPaid = standalone.totalPaid;
    totalOwed = standalone.totalOwed;
    remainingDebt = standalone.remaining;
  }

  return {
    totalPaid,
    totalOwed,
    remainingDebt,
    totalDebt: remainingDebt,
    activeQuotationId,
    quotationsWithBalance,
  };
}
