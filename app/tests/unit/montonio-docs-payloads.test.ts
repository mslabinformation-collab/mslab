import { afterEach, describe, expect, test, vi } from "vitest";
import { billingAddressOf } from "@/domain/financing";
import { signHs256, verifyHs256 } from "@/server/payments/jwt";
import { LIVE_BASE, montonioClient, type MontonioConfig } from "@/server/payments/montonio";
import { stubFetch } from "../fakes";

// The payloads below are copied from Montonio's own pages (read 09.10.2026), never derived from what this code produces: Rempire's shipping
// webhook was broken for months because its fixture was built flat to match the code while the real payload nested everything (its
// docs/montonio-shipping-audit.md § 1.1). Sources: docs.montonio.com/api/stargate/guides/orders (the decoded order token, the POST /orders
// answer, the webhook body) and the API reference "Get Order by UUID".

const config: MontonioConfig = { accessKey: "MY_ACCESS_KEY", secretKey: "docs-test-secret-0123456789abcdef", baseUrl: LIVE_BASE, live: true, mock: false, referencePrefix: "MSLAB-M" };

/** Orders guide, "Validating the returned order token": the decoded payload, its deprecated snake_case twins included. */
const ORDER_TOKEN_PAYLOAD = {
  uuid: "the-montonio-order-uuid",
  accessKey: "MY_ACCESS_KEY",
  merchantReference: "MY-ORDER-ID-123",
  merchantReferenceDisplay: "MY-ORDER-ID-123",
  paymentStatus: "PAID",
  paymentMethod: "paymentInitiation",
  grandTotal: 99.99,
  currency: "EUR",
  senderIban: "EE471000001020145685",
  senderName: "John Doe",
  paymentProviderName: "New Wave Bank Group",
  merchant_reference: "MY-ORDER-ID-123",
  merchant_reference_display: "MY-ORDER-ID-123",
  payment_status: "PAID",
  iat: 1632967333,
  exp: 1632967333,
};

/** Orders guide, the answer of POST /orders (its first fields). */
const ORDER_CREATED = {
  uuid: "12228dce-2f7c-4db5-8d28-5d82a19aa3b6",
  paymentStatus: "PENDING",
  merchantReference: "MY-ORDER-ID-123",
  paymentUrl: "https://stargate.montonio.com/e694c95b-0335-493d-a713-af95720f885d",
};

/** API reference, "Get Order by UUID": money as strings. */
const ORDER_BODY = {
  uuid: "0ac2124d-9f8e-4a29-816d-7eef5b9bb0fd",
  paymentStatus: "PARTIALLY_REFUNDED",
  locale: "et",
  merchantReference: "MY-ORDER-ID-123",
  merchantReferenceDisplay: "MY-ORDER-ID-123",
  merchantReturnUrl: "https://mystore.com/payment/return",
  merchantNotificationUrl: "https://mystore.com/payment/notify",
  grandTotal: "100.00",
  currency: "EUR",
  paymentMethodType: "cardPayments",
  paymentIntents: [
    { uuid: "293513c0-66b1-401a-8afa-75e1f5714516", paymentMethodType: "cardPayments", paymentMethodMetadata: {}, amount: "100.00", currency: "EUR", status: "PAID", serviceFee: "3.15", serviceFeeCurrency: "EUR", createdAt: "2023-05-23T08:22:53.899Z" },
  ],
  refunds: [{ uuid: "92b11684-319a-4cce-92f5-56d348aa986a", amount: "25", status: "SUCCESSFUL", currency: "EUR", createdAt: "2023-05-23T08:37:55.534Z", type: "PARTIAL_REFUND" }],
  availableForRefund: 50,
  isRefundableType: false,
  lineItems: [{ name: "Hoverboard", quantity: 1, finalPrice: 100 }],
  expiresAt: null,
  createdAt: "2023-05-23T08:22:53.879Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("Montonio's documented payloads", () => {
  test("the decoded order token: the reference, PAID, 99.99 € as 9999 cents, the method and the bank; expired only past exp + 60 s", () => {
    const token = signHs256(ORDER_TOKEN_PAYLOAD, config.secretKey, { nowSec: ORDER_TOKEN_PAYLOAD.iat });
    const atIssue = montonioClient(config, undefined, () => ORDER_TOKEN_PAYLOAD.iat * 1000);
    expect(atIssue.verifyOrderToken(token)).toEqual({
      uuid: "the-montonio-order-uuid",
      accessKey: "MY_ACCESS_KEY",
      reference: "MY-ORDER-ID-123",
      status: "paid",
      rawStatus: "PAID",
      amountCents: 9999,
      currency: "EUR",
      method: "paymentInitiation",
      bank: "New Wave Bank Group",
      expired: false,
    });
    const late = montonioClient(config, undefined, () => (ORDER_TOKEN_PAYLOAD.exp + 61) * 1000);
    expect(late.verifyOrderToken(token).expired).toBe(true);
  });

  test("the POST /orders answer: its uuid and paymentUrl", async () => {
    stubFetch(() => Response.json(ORDER_CREATED));
    const order = { reference: "MY-ORDER-ID-123", amountCents: 9999, locale: "et" as const, returnUrl: "https://mystore.com/payment/return", notificationUrl: "https://mystore.com/payment/notify" };
    expect(await montonioClient(config).createOrder(order)).toEqual({ uuid: ORDER_CREATED.uuid, paymentUrl: ORDER_CREATED.paymentUrl });
  });

  test("the järelmaks order's request uses only keys the orders guide lists (read 22.10.2026): expiresIn in minutes 5–44640, a billingAddress of string keys, a payment of method, amount and currency", async () => {
    const f = stubFetch(() => Response.json(ORDER_CREATED));
    const billing = billingAddressOf({ name: "Mari Tamm", email: "mari@example.test", phone: "5551 2345" });
    await montonioClient(config).createOrder({ reference: "MY-ORDER-ID-123", amountCents: 25000, locale: "et", returnUrl: "https://mystore.com/payment/return", notificationUrl: "https://mystore.com/payment/notify", method: "hirePurchase", billing });
    const { claims } = verifyHs256((f.calls[0].body as { data: string }).data, config.secretKey);
    const { payment, billingAddress, expiresIn } = claims as { payment: Record<string, unknown>; billingAddress: Record<string, unknown>; expiresIn: number };
    // "expiresIn: The number of minutes that the order can be paid for ... minimum 5 minutes, and maximum 44640 minutes"
    expect(Number.isInteger(expiresIn) && expiresIn >= 5 && expiresIn <= 44_640).toBe(true);
    // the billingAddress keys of the guide: firstName, lastName, email, phoneNumber, phoneCountry, addressLine1, addressLine2, locality, region, postalCode, country
    const documented = ["firstName", "lastName", "email", "phoneNumber", "phoneCountry", "addressLine1", "addressLine2", "locality", "region", "postalCode", "country"];
    expect(Object.keys(billingAddress).every((k) => documented.includes(k) && typeof billingAddress[k] === "string")).toBe(true);
    // the payment's: method (hirePurchase is in the guide's method table), amount and currency required; methodOptions has none for hirePurchase
    expect(Object.keys(payment).sort()).toEqual(["amount", "currency", "method"]);
    expect(payment.method).toBe("hirePurchase");
  });

  test("GET /orders/:uuid: PARTIALLY_REFUNDED is refunded, '100.00' is 10000 cents, the method is its paymentMethodType", async () => {
    stubFetch(() => Response.json(ORDER_BODY));
    expect(await montonioClient(config).fetchOrder(ORDER_BODY.uuid)).toEqual({
      uuid: ORDER_BODY.uuid,
      reference: "MY-ORDER-ID-123",
      status: "refunded",
      rawStatus: "PARTIALLY_REFUNDED",
      amountCents: 10000,
      currency: "EUR",
      method: "cardPayments",
    });
  });
});
