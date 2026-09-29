import { useEffect } from "react";

import { usePayments } from "./data";
import { setReceiptPayments } from "./payments";

/** Keeps the receipts' payment lookup in step with the payments on screen.
 * Mount once, high in the app. */
export function useReceiptPaymentIndex() {
  const { data } = usePayments();
  useEffect(() => {
    setReceiptPayments(data);
  }, [data]);
}
