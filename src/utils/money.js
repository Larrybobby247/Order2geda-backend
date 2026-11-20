// All money is integer kobo.
export const naira = (n) => Math.round(n * 100);
export const pct = (kobo, rate) => Math.round((kobo * rate) / 100);
export const closingThreshold = (target, buffer) => target + pct(target, buffer);
export const shippingShare = (totalShipping, custValue, groupValue) =>
  groupValue ? Math.round((totalShipping * custValue) / groupValue) : 0;
