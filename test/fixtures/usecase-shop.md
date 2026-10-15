# Professional Use Case Document

## Manage Online Shopping System - End-to-End Purchase and Fulfillment - UseCase

| Field | Details |
|---|---|
| **Use Case ID** | UC-SHOP-001 |
| **Use Case Name** | Manage Online Shopping System - End-to-End |
| **Version** | 1.0 |
| **Author** | QA Team |
| **Primary Actor** | Customer |
| **Secondary Actors** | Payment Gateway, Warehouse Staff |

## 1. Description
This use case describes how a registered customer finds a product, buys it and receives an order confirmation.

## 2. Preconditions
- The customer has a registered account.
- At least one product is in stock.

## 3. Trigger
The customer decides to buy a product.

## 4. Main Flow
1. The customer opens the online shopping website.
2. The customer logs in with email and password.
3. The customer searches for a product.
4. The system displays the matching products.
5. The customer selects a product and adds it to the cart.
6. The customer proceeds to checkout.
7. The customer enters the shipping address.
8. The customer selects a payment method and makes the payment.
9. The system confirms the order and displays the order number.
10. The system sends an order confirmation email.
11. Warehouse staff packs and ships the order.

## 5. Alternate Flows
- 3a. No product matches the search: the system displays "No products found".
- 8a. The payment is declined: the system displays "Payment declined".

## 6. Business Rules
- The shipping address is required.
- Password must be at least 8 characters.

## 7. Postconditions
- The order is placed and the customer sees the order number.
