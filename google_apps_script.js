/**
 * Google Apps Script - FutureWithAi PhonePe Serverless Backend (No Surprise Gift Email)
 * 
 * Instructions:
 * 1. Create a Google Sheet.
 * 2. Go to Extensions -> Apps Script.
 * 3. Delete any default code and paste this script.
 * 4. Click 'Save'.
 * 5. Go to 'Project Settings' (gear icon) -> Scroll down to 'Script Properties'.
 * 6. Add the following Script Properties:
 *    - PHONEPE_CLIENT_ID : SU2606121430539550011305
 *    - PHONEPE_CLIENT_SECRET : 7814af7d-d5ac-4afa-9a8e-5abb10936373
 *    - PHONEPE_WEBHOOK_USERNAME : Anshumanenterprises1
 *    - PHONEPE_WEBHOOK_PASSWORD : Webhookanshuman1119
 *    - CALLBACK_URL : (The Web App URL you copy in step 9 below - optional)
 * 7. Click 'Deploy' -> 'New deployment'.
 * 8. Select type 'Web app'. Configure:
 *    - Execute as: 'Me' (your email)
 *    - Who has access: 'Anyone'
 * 9. Click 'Deploy', authorize permissions, and copy the Web App URL.
 * 10. Replace APPS_SCRIPT_URL constant in checkout.html, payment-success.html, and access.html with this URL.
 */

// ── GET REQUESTS (CORS-Friendly Check Status) ─────────────────────
function doGet(e) {
  var action = e.parameter.action;
  
  if (action === "check_status") {
    var orderId = e.parameter.orderId;
    if (!orderId) {
      return jsonResponse({ success: false, message: "Missing orderId parameter." });
    }
    
    try {
      var raw = checkOrderStatus(orderId);
      var state = raw.state || "UNKNOWN";
      var isPaid = state === "COMPLETED";
      
      var payments = raw.paymentDetails || [];
      var successPayment = payments.find(function(p) { return p.state === "COMPLETED"; }) || {};
      var txnId = successPayment.transactionId || "";
      var amount = raw.amount ? "₹" + (raw.amount / 100) : "₹349";
      
      var name = (raw.metaInfo && raw.metaInfo.udf1) || "Customer";
      var email = (raw.metaInfo && raw.metaInfo.udf2) || "";
      var phone = (raw.metaInfo && raw.metaInfo.udf3) || "";
      
      if (isPaid) {
        var sheet = getOrCreateSheet("Sales Log");
        var alreadyDelivered = checkDuplicateOrder(sheet, orderId);
        
        if (!alreadyDelivered && email) {
          // Send Main Assets Email
          sendAssetEmail(name, email, orderId, txnId, amount);
          
          // Log sale details to Google Sheet and mark Email Sent as YES
          updateOrderStatusInSheet(sheet, orderId, txnId, "COMPLETED", "YES");
        } else {
          // Update status anyway in case it was pending in sheet
          updateOrderStatusInSheet(sheet, orderId, txnId, "COMPLETED", "YES");
        }
      } else if (state === "FAILED") {
        var sheet = getOrCreateSheet("Sales Log");
        updateOrderStatusInSheet(sheet, orderId, "", "FAILED", "NO");
      }
      
      return jsonResponse({
        success: true,
        merchantOrderId: orderId,
        phonePeOrderId: raw.orderId,
        state: state,
        isPaid: isPaid,
        isFailed: state === "FAILED",
        isPending: state === "PENDING",
        amount: raw.amount ? raw.amount / 100 : 349,
        successPayment: successPayment
      });
      
    } catch (err) {
      return jsonResponse({ success: false, error: err.toString() });
    }
  }
  
  return jsonResponse({ success: false, message: "Invalid GET action." });
}

// ── POST REQUESTS (Checkout Initiation, Webhook Callback, Leads) ──
function doPost(e) {
  try {
    var jsonString = e.postData.contents;
    var data = JSON.parse(jsonString);
    
    var action = data.action || e.parameter.action;
    
    // 1. PhonePe Webhook Callback (POST)
    if (action === "callback" || e.parameter.action === "callback") {
      var authHeader = e.parameter.authorization || "";
      if (!verifyWebhookSignature(authHeader)) {
        return jsonResponse({ status: "UNAUTHORIZED" });
      }
      
      var merchantOrderId = data.merchantOrderId || (data.data && data.data.merchantOrderId);
      var orderState = data.state || (data.data && data.data.state);
      
      if (merchantOrderId && orderState === "COMPLETED") {
        var raw = checkOrderStatus(merchantOrderId);
        var state = raw.state || "UNKNOWN";
        if (state === "COMPLETED") {
          var payments = raw.paymentDetails || [];
          var successPayment = payments.find(function(p) { return p.state === "COMPLETED"; }) || {};
          var txnId = successPayment.transactionId || "";
          var amount = raw.amount ? "₹" + (raw.amount / 100) : "₹349";
          
          var name = (raw.metaInfo && raw.metaInfo.udf1) || "Customer";
          var email = (raw.metaInfo && raw.metaInfo.udf2) || "";
          var phone = (raw.metaInfo && raw.metaInfo.udf3) || "";
          
          var sheet = getOrCreateSheet("Sales Log");
          var alreadyDelivered = checkDuplicateOrder(sheet, merchantOrderId);
          
          if (!alreadyDelivered && email) {
            sendAssetEmail(name, email, merchantOrderId, txnId, amount);
            updateOrderStatusInSheet(sheet, merchantOrderId, txnId, "COMPLETED", "YES");
          }
        }
      }
      
      return jsonResponse({ status: "OK" });
    }
    
    // 2. Initiate PhonePe Payment (POST)
    if (action === "initiate_payment") {
      var name = data.name || "Customer";
      var email = data.email || "";
      var phone = data.whatsapp || data.phone || "";
      var bizType = data.bizType || "";
      
      var orderDetails = createPaymentOrder(name, email, phone, bizType);
      return jsonResponse(orderDetails);
    }
    
    // 3. Lead Capture (Saves to sheet, sends no gift email)
    if (action === "lead_capture") {
      var name = data.name || "Customer";
      var email = data.email || "";
      var phone = data.whatsapp || data.phone || "";
      var profession = data.profession || "";
      var messageContent = data.aiMessage || "";
      
      var leadSheet = getOrCreateSheet("Leads Log");
      leadSheet.appendRow([
        new Date(),
        name,
        email,
        phone,
        profession,
        messageContent
      ]);
      
      return jsonResponse({ success: true, message: "Lead captured successfully!" });
    }
    
    return jsonResponse({ success: false, message: "Invalid POST action." });
    
  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  }
}

// ── PHONEPE API FUNCTIONS ──────────────────────────────────────────
function getAccessToken() {
  var props = PropertiesService.getScriptProperties();
  var clientId = props.getProperty("PHONEPE_CLIENT_ID") || "SU2606121430539550011305";
  var clientSecret = props.getProperty("PHONEPE_CLIENT_SECRET") || "7814af7d-d5ac-4afa-9a8e-5abb10936373";
  
  var cache = CacheService.getScriptCache();
  var cachedToken = cache.get("phonepe_access_token");
  if (cachedToken) {
    return cachedToken;
  }
  
  var url = "https://api.phonepe.com/apis/identity-manager/v1/oauth/token";
  var payload = {
    client_id: clientId,
    client_secret: clientSecret,
    client_version: "1",
    grant_type: "client_credentials"
  };
  
  var options = {
    method: "post",
    payload: payload,
    muteHttpExceptions: true
  };
  
  var response = UrlFetchApp.fetch(url, options);
  var data = JSON.parse(response.getContentText());
  
  if (data.access_token) {
    cache.put("phonepe_access_token", data.access_token, 3000); // cache for 50 mins
    return data.access_token;
  } else {
    throw new Error("PhonePe OAuth failed: " + JSON.stringify(data));
  }
}

function createPaymentOrder(name, email, phone, bizType) {
  var accessToken = getAccessToken();
  var merchantOrderId = generateOrderId();
  
  var props = PropertiesService.getScriptProperties();
  var callbackUrl = props.getProperty("CALLBACK_URL") || ScriptApp.getService().getUrl();
  
  if (callbackUrl.indexOf("?") === -1) {
    callbackUrl += "?action=callback";
  } else {
    callbackUrl += "&action=callback";
  }
  
  var successUrl = "https://anshumanenterprises.online/payment-success.html";
  var url = "https://api.phonepe.com/apis/pg/checkout/v2/pay";
  
  var payload = {
    merchantOrderId: merchantOrderId,
    amount: 34900, // ₹349 in paise
    expireAfter: 1200,
    metaInfo: {
      udf1: name,
      udf2: email,
      udf3: phone,
      udf4: "Ultimate n8n AI Automation Pack"
    },
    paymentFlow: {
      type: "PG_CHECKOUT",
      message: "Pay ₹349 for Ultimate n8n AI Automation Pack",
      merchantUrls: {
        redirectUrl: successUrl + "?orderId=" + merchantOrderId
      }
    }
  };
  
  var headers = {
    "Content-Type": "application/json",
    "Authorization": "O-Bearer " + accessToken,
    "X-CALLBACK-URL": callbackUrl
  };
  
  var options = {
    method: "post",
    headers: headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  
  var response = UrlFetchApp.fetch(url, options);
  var data = JSON.parse(response.getContentText());
  
  if (data.redirectUrl) {
    var sheet = getOrCreateSheet("Sales Log");
    sheet.appendRow([
      new Date(),
      merchantOrderId,
      "", // Transaction ID placeholder
      name,
      email,
      phone,
      "₹349",
      "PENDING",
      "NO"
    ]);
    
    return {
      success: true,
      redirectUrl: data.redirectUrl,
      merchantOrderId: merchantOrderId
    };
  } else {
    throw new Error("PhonePe pay initiation failed: " + JSON.stringify(data));
  }
}

function checkOrderStatus(merchantOrderId) {
  var accessToken = getAccessToken();
  var url = "https://api.phonepe.com/apis/pg/checkout/v2/order/" + merchantOrderId + "/status";
  
  var headers = {
    "Authorization": "O-Bearer " + accessToken,
    "Content-Type": "application/json"
  };
  
  var options = {
    method: "get",
    headers: headers,
    muteHttpExceptions: true
  };
  
  var response = UrlFetchApp.fetch(url, options);
  return JSON.parse(response.getContentText());
}

// ── EMAIL DISPATCH TEMPLATES ───────────────────────────────────────
function sendAssetEmail(name, email, orderId, txnId, amount) {
  var subject = "🎉 Access Granted: Ultimate n8n AI Automation Pack - FutureWithAi";
  
  var htmlBody = `
  <!DOCTYPE html>
  <html>
  <head>
    <style>
      body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f7f9fa; color: #333333; margin: 0; padding: 0; }
      .container { max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); overflow: hidden; border: 1px solid #eef2f5; }
      .header { background: linear-gradient(135deg, #ff8a00, #ffb77f); padding: 40px 30px; text-align: center; color: #ffffff; }
      .header h1 { margin: 0; font-size: 26px; font-weight: 700; text-shadow: 0 2px 4px rgba(0,0,0,0.1); }
      .content { padding: 40px 30px; line-height: 1.6; }
      .welcome { font-size: 18px; font-weight: bold; margin-bottom: 20px; color: #ff8a00; }
      .details-box { background-color: #fcf8f5; border: 1px solid #ffd8a8; border-radius: 8px; padding: 20px; margin: 25px 0; }
      .details-row { display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 14px; }
      .details-row:last-child { margin-bottom: 0; }
      .details-label { color: #888888; font-weight: 500; }
      .details-value { color: #333333; font-weight: 600; font-family: monospace; }
      .btn { display: block; text-align: center; background: linear-gradient(135deg, #ff8a00, #ffb77f); color: #000000 !important; text-decoration: none; padding: 16px 24px; border-radius: 8px; font-weight: bold; font-size: 16px; margin: 30px 0; box-shadow: 0 4px 10px rgba(255, 138, 0, 0.2); transition: all 0.3s ease; }
      .btn:hover { background: #ff8a00; }
      .community-box { background-color: #e6f9ed; border: 1px solid #b7f3cb; border-radius: 8px; padding: 20px; margin: 25px 0; border-left: 5px solid #25D366; }
      .community-title { font-weight: bold; color: #1ebea5; margin-bottom: 8px; }
      .community-btn { display: inline-block; background-color: #25D366; color: #ffffff !important; text-decoration: none; padding: 10px 18px; border-radius: 6px; font-weight: bold; font-size: 14px; margin-top: 10px; }
      .footer { background-color: #fafbfc; padding: 25px 30px; font-size: 12px; color: #888888; text-align: center; border-top: 1px solid #eef2f5; }
      .footer a { color: #ff8a00; text-decoration: none; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>Payment Successful!</h1>
      </div>
      <div class="content">
        <div class="welcome">Hello ${name},</div>
        <p>Thank you for your purchase! Your payment has been successfully processed and verified. You now have lifetime access to the <strong>Ultimate n8n AI Automation Pack</strong>.</p>
        
        <div class="details-box">
          <div class="details-row">
            <span class="details-label">Order ID:</span>
            <span class="details-value">${orderId}</span>
          </div>
          <div class="details-row">
            <span class="details-label">Transaction ID:</span>
            <span class="details-value">${txnId || "N/A"}</span>
          </div>
          <div class="details-row">
            <span class="details-label">Amount Paid:</span>
            <span class="details-value">${amount}</span>
          </div>
          <div class="details-row">
            <span class="details-label">Access Status:</span>
            <span class="details-value" style="color: #2e7d32;">GRANTED</span>
          </div>
        </div>

        <p>Click the button below to access the n8n Workflows GitHub repository directly. Make sure you are logged into your GitHub account to access/bookmark it:</p>
        
        <a href="https://github.com/anshumanenterprises1119/futurewithai" target="_blank" class="btn">Access n8n Workflow Vault 🚀</a>

        <div class="community-box">
          <div class="community-title">💬 Exclusive WhatsApp Insider Community</div>
          <p style="margin: 0; font-size: 14px; color: #333333;">Join our private WhatsApp group to connect with other automation builders, founders, and developers. Get updates, share custom nodes, and get support.</p>
          <a href="https://chat.whatsapp.com/EyFuaWsWiL895ON4cHtVl6" target="_blank" class="community-btn">Join Insider Community</a>
        </div>

        <p style="margin-top: 30px;">If you have any questions or require custom workflow development services, feel free to reply to this email or reach out on our WhatsApp support.</p>
        
        <p>Best regards,<br><strong>Aditya Tiwari</strong><br>Founder, FutureWithAi</p>
      </div>
      <div class="footer">
        Powered by <strong>Anshuman Enterprises</strong><br>
        Email: <a href="mailto:anshumanenterprises1119@gmail.com">anshumanenterprises1119@gmail.com</a> | Phone: +91 70658 15743<br>
        &copy; 2026 FutureWithAi. All Rights Reserved.
      </div>
    </div>
  </body>
  </html>
  `;
  
  try {
    MailApp.sendEmail({
      to: email,
      subject: subject,
      htmlBody: htmlBody,
      replyTo: "anshumanenterprises1119@gmail.com",
      name: "FutureWithAi Delivery System"
    });
    return true;
  } catch (error) {
    Logger.log("Email error: " + error.toString());
    return false;
  }
}

// ── UTILITIES & GOOGLE SHEET FUNCTIONS ─────────────────────────────
function getOrCreateSheet(sheetName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    if (sheetName === "Sales Log") {
      sheet.appendRow(["Timestamp", "Order ID", "Transaction ID", "Name", "Email", "WhatsApp/Phone", "Amount", "Payment Status", "Email Sent"]);
      sheet.getRange("A1:I1").setFontWeight("bold").setBackground("#ffd8a8");
    } else if (sheetName === "Leads Log") {
      sheet.appendRow(["Timestamp", "Name", "Email", "WhatsApp/Phone", "Profession", "Generated Message"]);
      sheet.getRange("A1:F1").setFontWeight("bold").setBackground("#ffd8a8");
    }
  }
  return sheet;
}

function checkDuplicateOrder(sheet, orderId) {
  if (!orderId) return false;
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] === orderId && data[i][8] === "YES") {
      return true;
    }
  }
  return false;
}

function updateOrderStatusInSheet(sheet, orderId, txnId, status, emailSent) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] === orderId) {
      var rowNum = i + 1;
      if (txnId) {
        sheet.getRange(rowNum, 3).setValue(txnId); // Col C (Transaction ID)
      }
      sheet.getRange(rowNum, 8).setValue(status);   // Col H (Payment Status)
      sheet.getRange(rowNum, 9).setValue(emailSent); // Col I (Email Sent)
      break;
    }
  }
}

function verifyWebhookSignature(authHeader) {
  var props = PropertiesService.getScriptProperties();
  var webhookUser = props.getProperty("PHONEPE_WEBHOOK_USERNAME") || "Anshumanenterprises1";
  var webhookPass = props.getProperty("PHONEPE_WEBHOOK_PASSWORD") || "Webhookanshuman1119";
  
  if (!authHeader) return false;
  if (authHeader.toLowerCase().indexOf("basic ") !== 0) return false;
  
  try {
    var base64Credentials = authHeader.substring(6).trim();
    var credentials = Utilities.newBlob(Utilities.base64Decode(base64Credentials)).getDataAsString();
    var parts = credentials.split(":");
    return parts[0] === webhookUser && parts[1] === webhookPass;
  } catch (err) {
    Logger.log("Webhook Auth error: " + err.toString());
    return false;
  }
}

function generateOrderId() {
  var ts = Date.now().toString(36).toUpperCase();
  var rand = Math.floor(Math.random() * 1000000).toString(36).toUpperCase();
  return "AEN8N-" + ts + "-" + rand;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}
