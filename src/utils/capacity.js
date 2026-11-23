export const HOLD_MIN = 15; // minutes a payment holds room capacity
export const GRACE_MIN = 10; // extra minutes a late payment is still accepted after the hold or a room closing
// Only PAID items count toward a room. A member may start paying only while paid + currently-held capacity is below the closing threshold.
export const hasCapacity = ({ paid, reserved, threshold }) => paid + reserved < threshold;
