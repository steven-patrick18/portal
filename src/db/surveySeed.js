// Survey module seed — 10 ready-to-use, short surveys for a garment
// manufacturer / wholesaler / exporter, plus the SMS template used to push
// a survey link. Idempotent: surveys seed only when the table is empty;
// the SMS template is ensured if missing.
//
// Question types: rating (1-5) | nps (0-10) | single | multi | yesno | text

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 60);
}

const SURVEYS = [
  { title: 'Customer Satisfaction', description: 'Tell us how we are doing — it takes under a minute.', questions: [
    { qtype: 'rating', qtext: 'Overall, how satisfied are you with Sharv Enterprises?' },
    { qtype: 'nps', qtext: 'How likely are you to recommend us to other retailers?' },
    { qtype: 'text', qtext: 'Any suggestions to serve you better?', required: 0 },
  ]},
  { title: 'Product Quality Feedback', description: 'Your feedback on the garments you received.', questions: [
    { qtype: 'rating', qtext: 'How would you rate the quality of our garments?' },
    { qtype: 'single', qtext: 'Which product did you order?', options: ['Kurtis', 'Sarees', 'Suits', 'Readymade wear', 'Other'] },
    { qtype: 'yesno', qtext: 'Did the product match the sample / description?' },
    { qtype: 'text', qtext: 'Comments on quality', required: 0 },
  ]},
  { title: 'Delivery & Dispatch Feedback', description: 'How was the delivery of your order?', questions: [
    { qtype: 'rating', qtext: 'How was your overall delivery experience?' },
    { qtype: 'yesno', qtext: 'Did your order arrive on time?' },
    { qtype: 'single', qtext: 'Condition of goods on arrival', options: ['Perfect', 'Minor issue', 'Damaged'] },
    { qtype: 'text', qtext: 'Any comments on delivery?', required: 0 },
  ]},
  { title: 'Net Promoter Score (NPS)', description: 'One quick question on whether you would recommend us.', questions: [
    { qtype: 'nps', qtext: 'How likely are you to recommend Sharv Enterprises to a fellow retailer?' },
    { qtype: 'text', qtext: 'What is the main reason for your score?', required: 0 },
  ]},
  { title: 'Dealer / Retailer Feedback', description: 'Help us support your business better.', questions: [
    { qtype: 'rating', qtext: 'How satisfied are you as our dealer?' },
    { qtype: 'rating', qtext: 'Rate our pricing competitiveness' },
    { qtype: 'rating', qtext: 'Rate our order-to-delivery speed' },
    { qtype: 'text', qtext: 'How can we support your business better?', required: 0 },
  ]},
  { title: 'Website Feedback', description: 'Tell us about your experience on sharvexports.com.', questions: [
    { qtype: 'rating', qtext: 'How easy was it to use our website?' },
    { qtype: 'yesno', qtext: 'Did you find what you were looking for?' },
    { qtype: 'text', qtext: 'What would you improve?', required: 0 },
  ]},
  { title: 'New Product Interest', description: 'Tell us what you would like to stock next season.', questions: [
    { qtype: 'multi', qtext: 'Which categories interest you next season?', options: ['Cotton kurtis', 'Party wear', 'Sarees', 'Kids wear', "Men's wear", 'Ethnic sets'] },
    { qtype: 'single', qtext: 'Preferred price range per piece', options: ['Under Rs 200', 'Rs 200-400', 'Rs 400-700', 'Rs 700+'] },
    { qtype: 'text', qtext: 'Any specific designs or fabrics you want?', required: 0 },
  ]},
  { title: 'Pricing Feedback', description: 'Your view on our pricing.', questions: [
    { qtype: 'rating', qtext: 'How do you rate our pricing versus other suppliers?' },
    { qtype: 'single', qtext: 'Our prices are', options: ['Very competitive', 'Fair', 'Slightly high', 'Too high'] },
    { qtype: 'text', qtext: 'Comments on pricing', required: 0 },
  ]},
  { title: 'After-Sales Service', description: 'How well did we handle your queries or issues?', questions: [
    { qtype: 'rating', qtext: 'Rate our response to your queries / complaints' },
    { qtype: 'yesno', qtext: 'Was your issue resolved satisfactorily?' },
    { qtype: 'text', qtext: 'Suggestions for better service', required: 0 },
  ]},
  { title: 'Order Experience', description: 'A quick check on your most recent order.', questions: [
    { qtype: 'rating', qtext: 'How was your overall ordering experience?' },
    { qtype: 'single', qtext: 'How did you place your order?', options: ['Salesperson', 'Phone / WhatsApp', 'Website', 'In person'] },
    { qtype: 'nps', qtext: 'How likely are you to order again?' },
    { qtype: 'text', qtext: 'Anything we can improve?', required: 0 },
  ]},
];

function uniqueSlug(raw, base) {
  let slug = base || 'survey', n = 1;
  while (raw.prepare('SELECT id FROM surveys WHERE slug=?').get(slug)) slug = base + '-' + (++n);
  return slug;
}

function seedSurveys(raw) {
  if (raw.prepare('SELECT COUNT(*) AS n FROM surveys').get().n > 0) return;
  const insS = raw.prepare('INSERT INTO surveys (slug,title,description,thank_you,active) VALUES (?,?,?,?,1)');
  const insQ = raw.prepare('INSERT INTO survey_questions (survey_id,position,qtype,qtext,options_json,required) VALUES (?,?,?,?,?,?)');
  for (const s of SURVEYS) {
    const slug = uniqueSlug(raw, slugify(s.title));
    const id = insS.run(slug, s.title, s.description || null, 'Thank you for your feedback! It helps us serve you better.').lastInsertRowid;
    s.questions.forEach((q, i) => insQ.run(id, i, q.qtype, q.qtext, q.options ? JSON.stringify(q.options) : null, q.required === 0 ? 0 : 1));
  }
}

// SMS template to push a survey link (kept in the SMS module; the survey
// module just triggers a broadcast with extra={link}).
function ensureSurveySmsTemplate(raw) {
  if (raw.prepare("SELECT 1 FROM sms_templates WHERE event='survey'").get()) return;
  raw.prepare("INSERT INTO sms_templates (event,label,dlt_template_id,body,var_order,active) VALUES ('survey',?,?,?,?,1)")
    .run('Survey invitation', '', 'Dear {dealer}, we value your feedback. Please take a short survey: {link} - {company}', 'dealer,link');
}

module.exports = { seedSurveys, ensureSurveySmsTemplate, slugify };
