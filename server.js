
const express = require("express");
const path = require("path");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET_KEY = sk_live_f56b34e253758b575dbc9b66377a0190cd6b2a84
const SUPABASE_URL = https://sbzdfqfxmvlfbkulltxs.supabase.co/rest/v1/
const SUPABASE_SERVICE_KEY = sb_publishable_lmUH4RtDQIRQw1004fxJpA_Qe-PF-cJ

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

// Health
app.get("/health", (req,res)=>res.json({status:"ok", store:"Savage's Pre Order"}));

// PRODUCTS API - from Supabase or fallback
app.get("/api/products", async (req,res)=>{
  try{
    if(!supabase) {
      return res.json([
        {id:"1", name:"Classic Street Sneakers", category:"Sneakers", price:450, stock:20, image:"https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=800", description:"Bold everyday sneaker from Atonsu."},
        {id:"2", name:"Premium Everyday Top", category:"Tops", price:180, stock:30, image:"https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=800", description:"Comfortable look for every day."},
        {id:"3", name:"Modern Lounge Chair", category:"Furniture", price:950, stock:5, image:"https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800", description:"Give your space a modern touch."}
      ]);
    }
    const {data, error} = await supabase.from("products").select("*").eq("active", true).order("created_at", {ascending:false});
    if(error) throw error;
    res.json(data);
  }catch(e){ console.error(e); res.status(500).json({error:"Could not load products"}) }
});

// CHECKOUT + PAYSTACK
app.post("/api/checkout", async (req,res)=>{
  try{
    if(!PAYSTACK_SECRET_KEY) return res.status(503).json({error:"Payment not configured. Add PAYSTACK_SECRET_KEY in Render."});
    const {customer, items, user_id} = req.body;
    if(!customer?.email || !items?.length) return res.status(400).json({error:"Missing checkout data"});

    let total = 0;
    for(const it of items) total += Number(it.price) * Number(it.qty);

    // Create order in Supabase
    let orderId = "SAV-" + Date.now();
    if(supabase){
      const {data, error} = await supabase.from("orders").insert([{
        user_id: user_id || null,
        customer_name: customer.name,
        customer_email: customer.email,
        customer_phone: customer.phone,
        customer_address: customer.address,
        total,
        status:"pending",
        items
      }]).select().single();
      if(!error && data) orderId = data.id;
    }

    const paystackRes = await fetch("https://api.paystack.co/transaction/initialize",{
      method:"POST",
      headers:{Authorization:"Bearer "+PAYSTACK_SECRET_KEY, "Content-Type":"application/json"},
      body: JSON.stringify({
        email: customer.email,
        amount: Math.round(total*100),
        currency:"GHS",
        callback_url: `https://savtel-store-4.onrender.com/payment/callback?order_id=${orderId}`,
        metadata:{order_id: orderId, customer_name: customer.name}
      })
    });
    const result = await paystackRes.json();
    if(!paystackRes.ok || !result.status) throw new Error(result.message || "Paystack failed");

    if(supabase){
      await supabase.from("orders").update({paystack_reference: result.data.reference}).eq("id", orderId);
    }

    res.json({authorization_url: result.data.authorization_url, reference: result.data.reference});
  }catch(err){ console.error(err); res.status(500).json({error: err.message}) }
});

app.get("/payment/callback", async (req,res)=>{
  const reference = req.query.reference;
  const order_id = req.query.order_id;
  if(!reference) return res.send("<h1>Missing reference</h1>");
  try{
    const verify = await fetch(`https://api.paystack.co/transaction/verify/${reference}`,{
      headers:{Authorization:"Bearer "+PAYSTACK_SECRET_KEY}
    });
    const data = await verify.json();
    if(data.data?.status === "success" && supabase && order_id){
      await supabase.from("orders").update({status:"paid", paid_at: new Date().toISOString()}).eq("id", order_id);
    }
    res.redirect("/?payment=success&order="+order_id);
  }catch(e){ res.redirect("/?payment=failed"); }
});

// ADMIN API
app.get("/api/admin/orders", async (req,res)=>{
  const auth = req.headers.authorization;
  if(!auth || !auth.includes(process.env.ADMIN_PASSWORD)) return res.status(401).json({error:"Unauthorized"});
  if(!supabase) return res.json([]);
  const {data} = await supabase.from("orders").select("*").order("created_at", {ascending:false});
  res.json(data || []);
});

app.listen(PORT, ()=>console.log("Savage's Pre Order LIVE on "+PORT));
