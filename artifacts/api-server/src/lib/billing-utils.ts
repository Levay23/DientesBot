/** Monto efectivo: abonos suman, devoluciones restan. */
export function signedPaymentAmount(amount: number, paymentType: string): number {
  return paymentType === "devolucion" ? -Math.abs(amount) : Math.abs(amount);
}

export function computeBalance(quotationTotal: number, paidAmount: number): number {
  return Math.max(0, quotationTotal - paidAmount);
}
