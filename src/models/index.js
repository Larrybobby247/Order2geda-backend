import mongoose from 'mongoose';
const { Schema, model } = mongoose; const oid = Schema.Types.ObjectId;
const t = { timestamps: true };
export const User = model('User', new Schema({
  fullName:{type:String,required:true}, email:{type:String,required:true,unique:true,lowercase:true},
  phone:String, passwordHash:{type:String,required:true}, profileImage:String,
  role:{type:String,enum:['CUSTOMER','MODERATOR','ADMIN'],default:'CUSTOMER',index:true},
  emailVerified:{type:Boolean,default:false}, accountStatus:{type:String,enum:['ACTIVE','SUSPENDED'],default:'ACTIVE'},
  referralCode:{type:String,unique:true}, referredBy:{type:oid,ref:'User'}, maxActiveRooms:{type:Number,default:5}, verifyTokenHash:String, fcmTokens:[String], passwordChangedAt:Date, deliveryAddress:{recipientName:String,phone:String,line1:String,city:String,state:String,landmark:String}, totpSecret:String, totpEnabled:{type:Boolean,default:false}, resetTokenHash:String, resetExpiresAt:Date,
  notificationPreferences:{type:Object,default:{email:true,push:true,chatEmail:false}}
}, t));
const roomSchema = new Schema({
  name:{type:String,required:true}, description:String, shoppingPlatform:String, category:String, coverImage:String,
  creator:{type:oid,ref:'User',required:true}, visibility:{type:String,enum:['PUBLIC','PRIVATE'],default:'PUBLIC'},
  invitationTokenHash:{type:String,index:true}, invitationExpiresAt:Date,
  targetAmount:{type:Number,required:true}, bufferPercentage:{type:Number,default:5},
  closingThreshold:{type:Number,required:true}, acceptedProductTotal:{type:Number,default:0},
  participants:[{type:oid,ref:'User'}], assignedModerator:{type:oid,ref:'User'},
  status:{type:String,enum:['OPEN','CLOSED','PROCESSING','COMPLETED','CANCELLED'],default:'OPEN'}, deadline:Date, closedAt:Date
}, t);
roomSchema.index({visibility:1,status:1,createdAt:-1});
export const Room = model('Room', roomSchema);
export const Product = model('Product', new Schema({
  room:{type:oid,ref:'Room',index:true}, customer:{type:oid,ref:'User',index:true},
  name:{type:String,required:true}, price:{type:Number,required:true,min:1}, quantity:{type:Number,required:true,min:1},
  image:String, productUrl:String, category:String, size:String, colour:String, description:String, instructions:String,
  verificationStatus:{type:String,enum:['PENDING','VERIFIED','FLAGGED','UNAVAILABLE'],default:'PENDING'},
  moderatorNotes:String, status:{type:String,enum:['ACTIVE','CANCELLED'],default:'ACTIVE'}
}, t));
const orderSchema = new Schema({
  orderReference:{type:String,unique:true}, room:{type:oid,ref:'Room',index:true}, customer:{type:oid,ref:'User',index:true},
  products:[{type:oid,ref:'Product'}], productSubtotal:Number, commissionRate:Number, commissionAmount:Number,
  estimatedShipping:{type:Number,default:0}, actualShipping:Number, otherCharges:{type:Number,default:0},
  walletCreditUsed:{type:Number,default:0}, totalAmount:Number, paidAmount:{type:Number,default:0},
  paymentStatus:{type:String,enum:['UNPAID','PAID','FAILED'],default:'UNPAID'},
  orderStatus:{type:String,default:'AWAITING_PAYMENT'}, refundStatus:{type:String,default:'NONE'},
  cancelledAt:Date, cancellationReason:String, flaggedForAdmin:{type:Boolean,default:false}
}, t);
orderSchema.index({room:1,customer:1},{unique:true});
export const Order = model('Order', orderSchema);
export const BulkOrder = model('BulkOrder', new Schema({
  room:{type:oid,ref:'Room',unique:true}, assignedModerator:{type:oid,ref:'User'}, customerOrders:[{type:oid,ref:'Order'}],
  externalPlatform:String, externalOrderReference:String, totalProductValue:Number, externalShipping:Number,
  bulkOrderStatus:{type:String,default:'PREPARING'}, proofAttachments:[String], placedAt:Date
}, t));
export const Payment = model('Payment', new Schema({
  customer:{type:oid,ref:'User'}, order:{type:oid,ref:'Order',index:true}, provider:{type:String,default:'paystack'},
  providerReference:{type:String,unique:true}, amount:Number, commissionAmount:Number, shippingAmount:Number,
  status:{type:String,enum:['PENDING','SUCCESS','FAILED'],default:'PENDING'}, verifiedAt:Date
}, t));
export const Refund = model('Refund', new Schema({
  customer:{type:oid,ref:'User'}, order:{type:oid,ref:'Order',unique:true}, originalPayment:{type:oid,ref:'Payment'},
  requestedAmount:Number, approvedAmount:Number, reason:String, description:String, bankName:String, accountName:String,
  encryptedAccountNumber:String, status:{type:String,enum:['PENDING','APPROVED','REJECTED','PROCESSING','COMPLETED'],default:'PENDING'},
  admin:{type:oid,ref:'User'}, transferReference:String, completedAt:Date
}, t));
export const ModeratorInvitation = model('ModeratorInvitation', new Schema({
  email:String, tokenHash:{type:String,index:true}, expiresAt:Date,
  status:{type:String,enum:['PENDING','ACCEPTED','REVOKED','EXPIRED'],default:'PENDING'}, invitedBy:{type:oid,ref:'User'}, acceptedAt:Date
}, t));
export const ModeratorAssignment = model('ModeratorAssignment', new Schema({
  moderator:{type:oid,ref:'User',index:true}, room:{type:oid,ref:'Room'}, assignedAt:{type:Date,default:Date.now}, releasedAt:Date,
  status:{type:String,enum:['ACTIVE','RELEASED','COMPLETED'],default:'ACTIVE'}, compensationRuleSnapshot:Object
}, t));
const compSchema = new Schema({
  moderator:{type:oid,ref:'User'}, room:{type:oid,ref:'Room'}, compensationType:{type:String,enum:['PERCENTAGE','FIXED']},
  rate:Number, calculationBasis:{type:String,enum:['PRODUCT_VALUE','PAID_ORDER_VALUE','FIXED_PER_ROOM']},
  eligibleAmount:Number, compensationAmount:Number, status:{type:String,enum:['PENDING','APPROVED','PAID','REVERSED'],default:'PENDING'},
  approvedBy:{type:oid,ref:'User'}, payoutReference:String, paidAt:Date
}, t);
compSchema.index({moderator:1,room:1},{unique:true});
export const ModeratorCompensation = model('ModeratorCompensation', compSchema);
const msgSchema = new Schema({
  room:{type:oid,ref:'Room'}, sender:{type:oid,ref:'User'}, content:String,
  messageType:{type:String,enum:['USER','SYSTEM','ANNOUNCEMENT'],default:'USER'}, attachments:[String],
  replyTo:{type:oid,ref:'Message'}, pinned:{type:Boolean,default:false}, deletedAt:Date
}, t);
msgSchema.index({room:1,createdAt:-1});
export const Message = model('Message', msgSchema);
const notifSchema = new Schema({ recipient:{type:oid,ref:'User'}, type:String, title:String, body:String, relatedEntity:{kind:String,id:oid}, readAt:Date, channels:[String] }, t);
notifSchema.index({recipient:1,readAt:1,createdAt:-1});
export const Notification = model('Notification', notifSchema);
export const Wallet = model('Wallet', new Schema({ user:{type:oid,ref:'User',unique:true}, availableBalance:{type:Number,default:0} }, t));
export const WalletTransaction = model('WalletTransaction', new Schema({
  wallet:{type:oid,ref:'Wallet'}, user:{type:oid,ref:'User',index:true}, type:{type:String,enum:['CREDIT','DEBIT','REVERSAL']},
  amount:Number, reference:{type:String,unique:true}, description:String, relatedOrder:{type:oid,ref:'Order'}, status:{type:String,default:'COMPLETED'}
}, t));
export const Referral = model('Referral', new Schema({
  referrer:{type:oid,ref:'User'}, referredUser:{type:oid,ref:'User',unique:true}, referralCode:String,
  qualifyingOrder:{type:oid,ref:'Order'}, rewardAmount:Number, status:{type:String,enum:['PENDING','CREDITED','REVERSED'],default:'PENDING'}, creditedAt:Date
}, t));
export const CompensationRule = model('CompensationRule', new Schema({ moderator:{type:oid,ref:'User',index:true}, room:{type:oid,ref:'Room'}, compensationType:{type:String,enum:['PERCENTAGE','FIXED']}, rate:Number,
  calculationBasis:{type:String,enum:['PRODUCT_VALUE','PAID_ORDER_VALUE','FIXED_PER_ROOM']}, effectiveFrom:{type:Date,default:Date.now}, status:{type:String,enum:['ACTIVE','INACTIVE'],default:'ACTIVE'}, createdBy:{type:oid,ref:'User'} }, t));
const crSchema = new Schema({ user:{type:oid,ref:'User'}, room:{type:oid,ref:'Room'}, lastReadAt:Date }, t); crSchema.index({user:1,room:1},{unique:true});
export const ChatRead = model('ChatRead', crSchema);
export const Setting = model('Setting', new Schema({ key:{type:String,unique:true}, value:Schema.Types.Mixed }, t));
export const AuditLog = model('AuditLog', new Schema({
  actor:{type:oid,ref:'User'}, actorRole:String, action:String, entityType:String, entityId:oid, previousValues:Object, newValues:Object, metadata:Object
}, { timestamps:{createdAt:'timestamp',updatedAt:false} }));
