// Survey module seed — 10 ready-to-use, short, BILINGUAL surveys (English +
// Hindi) for a garment manufacturer / wholesaler / exporter, plus the SMS
// template used to push a survey link. Idempotent: surveys seed only when
// the table is empty; Hindi is back-filled onto existing rows; the SMS
// template is ensured if missing.
//
// Question types: rating (1-5) | nps (0-10) | single | multi | yesno | text

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 60);
}

const SURVEYS = [
  { title: 'Customer Satisfaction', title_hi: 'ग्राहक संतुष्टि',
    description: 'Tell us how we are doing — it takes under a minute.', description_hi: 'बताइए हम कैसा कर रहे हैं — एक मिनट से भी कम लगेगा।',
    thank_you_hi: 'आपकी प्रतिक्रिया के लिए धन्यवाद!', questions: [
    { qtype: 'rating', qtext: 'Overall, how satisfied are you with Sharv Enterprises?', qtext_hi: 'कुल मिलाकर, आप शार्व एंटरप्राइजेज से कितने संतुष्ट हैं?' },
    { qtype: 'nps', qtext: 'How likely are you to recommend us to other retailers?', qtext_hi: 'आप हमें दूसरे रिटेलर्स को सुझाने की कितनी संभावना रखते हैं?' },
    { qtype: 'text', qtext: 'Any suggestions to serve you better?', qtext_hi: 'हमें बेहतर सेवा देने के लिए कोई सुझाव?', required: 0 },
  ]},
  { title: 'Product Quality Feedback', title_hi: 'उत्पाद गुणवत्ता प्रतिक्रिया',
    description: 'Your feedback on the garments you received.', description_hi: 'आपको मिले कपड़ों पर आपकी राय।', questions: [
    { qtype: 'rating', qtext: 'How would you rate the quality of our garments?', qtext_hi: 'हमारे कपड़ों की गुणवत्ता को आप कैसे आँकेंगे?' },
    { qtype: 'single', qtext: 'Which product did you order?', qtext_hi: 'आपने कौन सा उत्पाद ऑर्डर किया?', options: ['Kurtis', 'Sarees', 'Suits', 'Readymade wear', 'Other'], options_hi: ['कुर्ती', 'साड़ी', 'सूट', 'रेडीमेड वेयर', 'अन्य'] },
    { qtype: 'yesno', qtext: 'Did the product match the sample / description?', qtext_hi: 'क्या उत्पाद सैंपल/विवरण से मेल खाता था?' },
    { qtype: 'text', qtext: 'Comments on quality', qtext_hi: 'गुणवत्ता पर टिप्पणी', required: 0 },
  ]},
  { title: 'Delivery & Dispatch Feedback', title_hi: 'डिलीवरी और डिस्पैच प्रतिक्रिया',
    description: 'How was the delivery of your order?', description_hi: 'आपके ऑर्डर की डिलीवरी कैसी रही?', questions: [
    { qtype: 'rating', qtext: 'How was your overall delivery experience?', qtext_hi: 'कुल मिलाकर आपका डिलीवरी अनुभव कैसा रहा?' },
    { qtype: 'yesno', qtext: 'Did your order arrive on time?', qtext_hi: 'क्या आपका ऑर्डर समय पर पहुँचा?' },
    { qtype: 'single', qtext: 'Condition of goods on arrival', qtext_hi: 'पहुँचने पर सामान की स्थिति', options: ['Perfect', 'Minor issue', 'Damaged'], options_hi: ['बिल्कुल सही', 'मामूली समस्या', 'क्षतिग्रस्त'] },
    { qtype: 'text', qtext: 'Any comments on delivery?', qtext_hi: 'डिलीवरी पर कोई टिप्पणी?', required: 0 },
  ]},
  { title: 'Net Promoter Score (NPS)', title_hi: 'नेट प्रमोटर स्कोर (NPS)',
    description: 'One quick question on whether you would recommend us.', description_hi: 'एक छोटा सवाल — क्या आप हमें सुझाएँगे।', questions: [
    { qtype: 'nps', qtext: 'How likely are you to recommend Sharv Enterprises to a fellow retailer?', qtext_hi: 'आप किसी साथी रिटेलर को शार्व एंटरप्राइजेज सुझाने की कितनी संभावना रखते हैं?' },
    { qtype: 'text', qtext: 'What is the main reason for your score?', qtext_hi: 'आपके स्कोर का मुख्य कारण क्या है?', required: 0 },
  ]},
  { title: 'Dealer / Retailer Feedback', title_hi: 'डीलर / रिटेलर प्रतिक्रिया',
    description: 'Help us support your business better.', description_hi: 'आपके व्यापार में बेहतर मदद के लिए।', questions: [
    { qtype: 'rating', qtext: 'How satisfied are you as our dealer?', qtext_hi: 'हमारे डीलर के रूप में आप कितने संतुष्ट हैं?' },
    { qtype: 'rating', qtext: 'Rate our pricing competitiveness', qtext_hi: 'हमारी कीमतों की प्रतिस्पर्धात्मकता को आँकें' },
    { qtype: 'rating', qtext: 'Rate our order-to-delivery speed', qtext_hi: 'ऑर्डर से डिलीवरी तक की गति को आँकें' },
    { qtype: 'text', qtext: 'How can we support your business better?', qtext_hi: 'हम आपके व्यापार में कैसे बेहतर मदद कर सकते हैं?', required: 0 },
  ]},
  { title: 'Website Feedback', title_hi: 'वेबसाइट प्रतिक्रिया',
    description: 'Tell us about your experience on sharvexports.com.', description_hi: 'sharvexports.com पर आपके अनुभव के बारे में बताएं।', questions: [
    { qtype: 'rating', qtext: 'How easy was it to use our website?', qtext_hi: 'हमारी वेबसाइट इस्तेमाल करना कितना आसान था?' },
    { qtype: 'yesno', qtext: 'Did you find what you were looking for?', qtext_hi: 'क्या आपको वह मिला जो आप ढूंढ रहे थे?' },
    { qtype: 'text', qtext: 'What would you improve?', qtext_hi: 'आप क्या सुधारेंगे?', required: 0 },
  ]},
  { title: 'New Product Interest', title_hi: 'नए उत्पाद में रुचि',
    description: 'Tell us what you would like to stock next season.', description_hi: 'बताएं अगले सीज़न में आप क्या स्टॉक करना चाहेंगे।', questions: [
    { qtype: 'multi', qtext: 'Which categories interest you next season?', qtext_hi: 'अगले सीज़न में कौन सी श्रेणियाँ आपकी रुचि में हैं?', options: ['Cotton kurtis', 'Party wear', 'Sarees', 'Kids wear', "Men's wear", 'Ethnic sets'], options_hi: ['कॉटन कुर्ती', 'पार्टी वेयर', 'साड़ी', 'किड्स वेयर', 'मेन्स वेयर', 'एथनिक सेट'] },
    { qtype: 'single', qtext: 'Preferred price range per piece', qtext_hi: 'प्रति पीस पसंदीदा मूल्य सीमा', options: ['Under Rs 200', 'Rs 200-400', 'Rs 400-700', 'Rs 700+'], options_hi: ['₹200 से कम', '₹200-400', '₹400-700', '₹700+'] },
    { qtype: 'text', qtext: 'Any specific designs or fabrics you want?', qtext_hi: 'कोई विशेष डिज़ाइन या कपड़ा जो आप चाहते हैं?', required: 0 },
  ]},
  { title: 'Pricing Feedback', title_hi: 'मूल्य निर्धारण प्रतिक्रिया',
    description: 'Your view on our pricing.', description_hi: 'हमारी कीमतों पर आपकी राय।', questions: [
    { qtype: 'rating', qtext: 'How do you rate our pricing versus other suppliers?', qtext_hi: 'अन्य आपूर्तिकर्ताओं की तुलना में हमारी कीमतों को आप कैसे आँकेंगे?' },
    { qtype: 'single', qtext: 'Our prices are', qtext_hi: 'हमारी कीमतें हैं', options: ['Very competitive', 'Fair', 'Slightly high', 'Too high'], options_hi: ['बहुत प्रतिस्पर्धी', 'उचित', 'थोड़ी ज़्यादा', 'बहुत ज़्यादा'] },
    { qtype: 'text', qtext: 'Comments on pricing', qtext_hi: 'कीमतों पर टिप्पणी', required: 0 },
  ]},
  { title: 'After-Sales Service', title_hi: 'बिक्री-पश्चात सेवा',
    description: 'How well did we handle your queries or issues?', description_hi: 'हमने आपकी पूछताछ या समस्याओं को कितनी अच्छी तरह संभाला?', questions: [
    { qtype: 'rating', qtext: 'Rate our response to your queries / complaints', qtext_hi: 'आपकी पूछताछ / शिकायतों पर हमारी प्रतिक्रिया को आँकें' },
    { qtype: 'yesno', qtext: 'Was your issue resolved satisfactorily?', qtext_hi: 'क्या आपकी समस्या संतोषजनक रूप से हल हुई?' },
    { qtype: 'text', qtext: 'Suggestions for better service', qtext_hi: 'बेहतर सेवा के लिए सुझाव', required: 0 },
  ]},
  { title: 'Order Experience', title_hi: 'ऑर्डर अनुभव',
    description: 'A quick check on your most recent order.', description_hi: 'आपके हाल के ऑर्डर पर एक त्वरित जाँच।', questions: [
    { qtype: 'rating', qtext: 'How was your overall ordering experience?', qtext_hi: 'कुल मिलाकर आपका ऑर्डर देने का अनुभव कैसा रहा?' },
    { qtype: 'single', qtext: 'How did you place your order?', qtext_hi: 'आपने ऑर्डर कैसे दिया?', options: ['Salesperson', 'Phone / WhatsApp', 'Website', 'In person'], options_hi: ['सेल्सपर्सन', 'फ़ोन / व्हाट्सएप', 'वेबसाइट', 'व्यक्तिगत रूप से'] },
    { qtype: 'nps', qtext: 'How likely are you to order again?', qtext_hi: 'दोबारा ऑर्डर करने की कितनी संभावना है?' },
    { qtype: 'text', qtext: 'Anything we can improve?', qtext_hi: 'हम क्या सुधार सकते हैं?', required: 0 },
  ]},
];

function uniqueSlug(raw, base) {
  let slug = base || 'survey', n = 1;
  while (raw.prepare('SELECT id FROM surveys WHERE slug=?').get(slug)) slug = base + '-' + (++n);
  return slug;
}

function seedSurveys(raw) {
  if (raw.prepare('SELECT COUNT(*) AS n FROM surveys').get().n > 0) return;
  const insS = raw.prepare('INSERT INTO surveys (slug,title,title_hi,description,description_hi,thank_you,thank_you_hi,active) VALUES (?,?,?,?,?,?,?,1)');
  const insQ = raw.prepare('INSERT INTO survey_questions (survey_id,position,qtype,qtext,qtext_hi,options_json,options_hi_json,required) VALUES (?,?,?,?,?,?,?,?)');
  for (const s of SURVEYS) {
    const slug = uniqueSlug(raw, slugify(s.title));
    const id = insS.run(slug, s.title, s.title_hi || null, s.description || null, s.description_hi || null,
      'Thank you for your feedback! It helps us serve you better.', s.thank_you_hi || null).lastInsertRowid;
    s.questions.forEach((q, i) => insQ.run(id, i, q.qtype, q.qtext, q.qtext_hi || null,
      q.options ? JSON.stringify(q.options) : null, q.options_hi ? JSON.stringify(q.options_hi) : null, q.required === 0 ? 0 : 1));
  }
}

// Back-fill Hindi onto surveys that already exist (English-only) without
// touching anything the user has since edited (only fills blank _hi fields,
// matched by the English text).
function backfillHindi(raw) {
  const upS = raw.prepare("UPDATE surveys SET title_hi=COALESCE(title_hi,?), description_hi=COALESCE(description_hi,?), thank_you_hi=COALESCE(thank_you_hi,?) WHERE title=? AND (title_hi IS NULL OR title_hi='')");
  const upQ = raw.prepare("UPDATE survey_questions SET qtext_hi=COALESCE(qtext_hi,?), options_hi_json=COALESCE(options_hi_json,?) WHERE qtext=? AND (qtext_hi IS NULL OR qtext_hi='')");
  for (const s of SURVEYS) {
    upS.run(s.title_hi || null, s.description_hi || null, s.thank_you_hi || null, s.title);
    s.questions.forEach(q => upQ.run(q.qtext_hi || null, q.options_hi ? JSON.stringify(q.options_hi) : null, q.qtext));
  }
}

function ensureSurveySmsTemplate(raw) {
  if (raw.prepare("SELECT 1 FROM sms_templates WHERE event='survey'").get()) return;
  raw.prepare("INSERT INTO sms_templates (event,label,dlt_template_id,body,var_order,active) VALUES ('survey',?,?,?,?,1)")
    .run('Survey invitation', '', 'Dear {dealer}, we value your feedback. Please take a short survey: {link} - {company}', 'dealer,link');
}

module.exports = { seedSurveys, ensureSurveySmsTemplate, backfillHindi, slugify };
