
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";

function requireConfig() {
  if (
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY ||
    !PAYSTACK_SECRET_KEY
  ) {
    throw new Error("Server payment or database configuration is missing.");
  }
}

// Customer authentication
async function authenticate(req, res, next) {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ error: "Please log in first." });
    }

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      return res.status(401).json({ error: "Invalid login session." });
    }

    req.user = data.user;
    next();
  } catch {
    res.status(500).json({ error: "Authentication failed." });
  }
}

// Admin protection
async function requireAdmin(req, res, next) {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", req.user.id)
      .single();

    if (error || data?.role !== "admin") {
      return res.status(403).json({ error: "Admin access required." });
    }

    next();
  } catch {
    res.status(500).json({ error: "Admin verification failed." });
  }
}

// Home API
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    store: "Savage's Pre Order"
  });
});

// Get products
app.get("/api/products", async (req, res) => {
  try {
    requireConfig();

    const { data, error } = await supabase
      .from("products")
      .select("*")
      .eq("active", true)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Initialize secure Paystack checkout
app.post("/api/payments/initialize", authenticate, async (req, res) => {
  let orderId;

  try {
    requireConfig();

    const { items, delivery } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Your cart is empty." });
    }

    if (
      !delivery?.name ||
      !delivery?.phone ||
      !delivery?.address
    ) {
      return res.status(400).json({
        error: "Complete your delivery information."
      });
    }

    const quantities = new Map();

    for (const item of items) {
      const id = String(item.product_id || "");
      const quantity = Number(item.quantity);

      if (
        !id ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 20
      ) {
        return res.status(400).json({
          error: "Invalid product or quantity."
        });
      }

      quantities.set(id, (quantities.get(id) || 0) + quantity);
    }

    const productIds = [...quantities.keys()];

    const { data: products, error: productError } = await supabase
      .from("products")
      .select("id,name,price,active")
      .in("id", productIds);

    if (productError) throw productError;

    if (
      !products ||
      products.length !== productIds.length ||
      products.some(p => !p.active)
    ) {
      return res.status(400).json({
        error: "One or more products are unavailable."
      });
    }

    const orderItems = products.map(product => ({
      product_id: product.id,
      product_name: product.name,
      quantity: quantities.get(product.id),
      unit_price: Number(product.price)
    }));

    const total = orderItems.reduce(
      (sum, item) => sum + item.unit_price * item.quantity,
      0
    );

    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({ error: "Invalid order total." });
    }

    const reference =
      "SAVAGE_" + Date.now() + "_" +
      Math.random().toString(36).slice(2, 9);

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert({
        customer_id: req.user.id,
        customer_name: delivery.name,
        customer_phone: delivery.phone,
        delivery_address: delivery.address,
        total_amount: total,
        currency: "GHS",
        payment_reference: reference,
        payment_status: "pending",
        order_status: "pending"
      })
      .select()
      .single();

    if (orderError) throw orderError;

    orderId = order.id;

    const savedItems = orderItems.map(item => ({
      ...item,
      order_id: order.id
    }));

    const { error: itemsError } = await supabase
      .from("order_items")
      .insert(savedItems);

    if (itemsError) throw itemsError;

    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: req.user.email,
          amount: Math.round(total * 100),
          currency: "GHS",
          reference,
          callback_url:
            `${process.env.SITE_URL}/payment-success.html`,
          metadata: {
            order_id: order.id,
            customer_id: req.user.id
          }
        })
      }
    );

    const payment = await response.json();

    if (!response.ok || !payment.status) {
      throw new Error(payment.message || "Payment initialization failed.");
    }

    res.json({
      authorization_url: payment.data.authorization_url,
      reference,
      order_id: order.id
    });

  } catch (error) {
    if (orderId) {
      await supabase
        .from("orders")
        .update({ payment_status: "failed" })
        .eq("id", orderId);
    }

    res.status(500).json({
      error: error.message || "Checkout failed."
    });
  }
});

// Verify Paystack payment
app.get("/api/payments/verify/:reference", authenticate, async (req, res) => {
  try {
    requireConfig();

    const reference = req.params.reference;

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("*")
      .eq("payment_reference", reference)
      .eq("customer_id", req.user.id)
      .single();

    if (orderError || !order) {
      return res.status(404).json({ error: "Order not found." });
    }

    if (order.payment_status === "paid") {
      return res.json({ status: "success", order });
    }

    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
        }
      }
    );

    const result = await response.json();
    const transaction = result.data;

    if (
      !response.ok ||
      !result.status ||
      transaction.status !== "success" ||
      transaction.currency !== "GHS" ||
      transaction.amount !== Math.round(Number(order.total_amount) * 100)
    ) {
      return res.status(400).json({
        error: "Payment has not been confirmed."
      });
    }

    const { data: updatedOrder, error: updateError } = await supabase
      .from("orders")
      .update({
        payment_status: "paid",
        order_status: "processing"
      })
      .eq("id", order.id)
      .eq("payment_status", "pending")
      .select()
      .single();

    if (updateError) throw updateError;

    res.json({
      status: "success",
      order: updatedOrder
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Customer order history
app.get("/api/my-orders", authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("orders")
      .select("*,order_items(*)")
      .eq("customer_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: add product
app.post("/api/admin/products", authenticate, requireAdmin, async (req, res) => {
  try {
    const { name, description, category, price, image_url } = req.body;

    if (
      !name ||
      !["Sneakers", "Tops", "Furniture"].includes(category) ||
      !Number.isFinite(Number(price)) ||
      Number(price) <= 0
    ) {
      return res.status(400).json({ error: "Invalid product details." });
    }

    const { data, error } = await supabase
      .from("products")
      .insert({
        name,
        description,
        category,
        price: Number(price),
        image_url,
        active: true
      })
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: edit product
app.patch("/api/admin/products/:id", authenticate, requireAdmin, async (req, res) => {
  try {
    const allowed = [
      "name", "description", "category",
      "price", "image_url", "active"
    ];

    const updates = {};

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    }

    if (
      updates.category !== undefined &&
      !["Sneakers", "Tops", "Furniture"].includes(updates.category)
    ) {
      return res.status(400).json({ error: "Invalid category." });
    }

    if (
      updates.price !== undefined &&
      (!Number.isFinite(Number(updates.price)) || Number(updates.price) <= 0)
    ) {
      return res.status(400).json({ error: "Invalid price." });
    }

    const { data, error } = await supabase
      .from("products")
      .update(updates)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: delete product (soft delete)
app.delete("/api/admin/products/:id", authenticate, requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from("products")
      .update({ active: false })
      .eq("id", req.params.id);

    if (error) throw error;

    res.json({ message: "Product removed from store." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: view all orders
app.get("/api/admin/orders", authenticate, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("orders")
      .select("*,order_items(*)")
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: update order status
app.patch("/api/admin/orders/:id", authenticate, requireAdmin, async (req, res) => {
  try {
    const allowedStatuses = [
      "pending", "processing", "shipped", "delivered", "cancelled"
    ];

    const status = req.body.order_status;

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid order status." });
    }

    const { data, error } = await supabase
      .from("orders")
      .update({ order_status: status })
      .eq("id", req.params.id)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// WhatsApp support
app.get("/api/support", (req, res) => {
  res.json({
    whatsapp: "https://wa.me/233257980924",
    phone: "0257980924"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Savage's Pre Order running on port ${PORT}`);
});
