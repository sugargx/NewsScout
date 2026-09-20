const {chromium}=require("playwright");
const net=require("node:net");

function identity(value) {
  const url=new URL(value);
  if(url.protocol!=="https:"||url.username||url.password||url.port&&url.port!=="443")throw new Error("Only credential-free public HTTPS article URLs are supported.");
  url.hash="";
  url.pathname=url.pathname.replace(/\/+$/,"")||"/";
  return url.href;
}

function normalizeTitle(value) {
  return value.replace(/\s+/gu," ").trim().toLocaleLowerCase("en");
}

function isPublicAddress(value) {
  const version=net.isIP(value);
  if(version===4) {
    const [a,b,c]=value.split(".").map(Number);
    return a>0&&a<224&&a!==10&&a!==127&&!(a===169&&b===254)
      &&!(a===172&&b>=16&&b<=31)&&!(a===192&&b===168)
      &&!(a===100&&b>=64&&b<=127)&&!(a===192&&b===0&&(c===0||c===2))
      &&!(a===192&&b===88&&c===99)&&!(a===198&&(b===18||b===19||b===51&&c===100))
      &&!(a===203&&b===0&&c===113);
  }
  if(version===6) {
    const parts=value.toLowerCase().split(":");
    const first=parseInt(parts[0],16),second=parts[1]?parseInt(parts[1],16):0;
    return (first&0xe000)===0x2000&&first!==0x2002
      &&!(first===0x2001&&(second<0x200||second===0xdb8))
      &&!(first===0x3fff&&second<0x1000);
  }
  return false;
}

function validateInput(input) {
  if(!input||typeof input.url!=="string"||typeof input.title!=="string"||typeof input.address!=="string")throw new Error("Missing article capture input.");
  const url=new URL(identity(input.url));
  if(!url.hostname.includes(".")||net.isIP(url.hostname.replace(/^\[|\]$/g,"")))throw new Error("An original publisher hostname is required.");
  if(input.url.length>2048||input.title.length>1000||!normalizeTitle(input.title))throw new Error("Invalid article identity.");
  if(!isPublicAddress(input.address))throw new Error("A server-validated public DNS address is required.");
  return {...input,url:url.href};
}

async function capture(raw) {
  const input=validateInput(raw);
  const target=new URL(input.url);
  const address=net.isIP(input.address)===6?`[${input.address}]`:input.address;
  let browser;
  let deadline;
  try {
    browser=await chromium.launch({
      channel:input.channel??"msedge",headless:input.headless===true,timeout:12000,
      args:[`--host-resolver-rules=MAP ${target.hostname} ${address}, MAP * ~NOTFOUND`],
    });
    const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:"block",acceptDownloads:false});
    await context.route("**/*",async route=>{
      const request=route.request();
      const url=new URL(request.url());
      const allowed=url.protocol==="https:"&&!url.username&&!url.password&&url.origin===target.origin
        &&request.method()==="GET"
        &&(!request.isNavigationRequest()||identity(url.href)===identity(input.url));
      if(!allowed||["image","media","font"].includes(request.resourceType()))return route.abort("blockedbyclient");
      return route.continue();
    });
    await context.routeWebSocket("**/*",socket=>socket.close());
    const page=await context.newPage();
    context.on("page",popup=>{if(popup!==page)void popup.close();});
    deadline=setTimeout(()=>{void browser.close();},45000);
    const response=await page.goto(input.url,{waitUntil:"commit",timeout:25000});
    const status=response?.status()??0;
    if(status!==200) {
      return {ok:false,code:"http_error",status,message:`Original publisher browser request returned HTTP ${status}.`,
        retryAfter:response?.headers()["retry-after"]??null};
    }
    if(!/^text\/html(?:;|$)/i.test(response.headers()["content-type"]??"")) {
      return {ok:false,code:"invalid_content_type",message:"Publisher response is not HTML."};
    }
    if(Number(response.headers()["content-length"]??0)>4*1024*1024) {
      return {ok:false,code:"oversized_document",message:"Publisher HTML exceeds the document bound."};
    }
    await page.waitForLoadState("domcontentloaded",{timeout:15000});
    const result=await page.evaluate(({expected,maxChars})=>{
      const normalize=value=>value.replace(/\s+/gu," ").trim().toLocaleLowerCase("en");
      const heading=Array.from(document.querySelectorAll("h1")).find(node=>normalize(node.textContent??"")===expected);
      const whole=(document.body?.innerText??"").slice(0,20000);
      if(/verify (?:that )?you are human|just a moment|checking your browser|enable javascript and cookies|access denied|subscribe to (?:continue|read)|sign in to (?:continue|read)|log in to (?:continue|read)|unlock this article/i.test(whole)) {
        return {ok:false,code:"verification_required",message:"Publisher requires verification; capture stopped."};
      }
      if(!heading)return {ok:false,code:"identity_mismatch",message:"The requested article title was not found."};
      const root=heading.closest("article")??heading.closest("main,[role='main']");
      if(!root)return {ok:false,code:"missing_article",message:"No substantive article region was found."};
      const pieces=[];
      const skip="script,style,noscript,nav,aside,footer,header,form,button,iframe,svg,h1,[hidden],[aria-hidden='true'],[role='navigation'],[role='status']";
      const block=new Set(["P","DIV","SECTION","ARTICLE","H2","H3","H4","H5","H6","LI","BLOCKQUOTE","PRE","TR"]);
      function walk(node) {
        if(node.nodeType===Node.TEXT_NODE){pieces.push(node.nodeValue??"");return;}
        if(!(node instanceof Element)||node.matches(skip))return;
        const style=getComputedStyle(node);
        if(style.display==="none"||style.visibility==="hidden"||style.visibility==="collapse"||style.opacity==="0"||style.contentVisibility==="hidden")return;
        if(node.tagName==="BR"){pieces.push("\n");return;}
        const separated=block.has(node.tagName);
        if(separated)pieces.push("\n\n");
        for(const child of node.childNodes)walk(child);
        if(separated)pieces.push("\n\n");
      }
      walk(root);
      const text=pieces.join("").split("\n").map(line=>line.replace(/[^\S\n]+/gu," ").trim())
        .filter(line=>! /^(?:Loading(?:…|\.\.\.)?|Share|\(opens in a new window\)|\d+ of \d+)$/i.test(line))
        .join("\n").replace(/\n{3,}/g,"\n\n").trim();
      if(text.length<240)return {ok:false,code:"insufficient_article",message:"The original article region contains too little text."};
      const chars=Array.from(text);
      return {ok:true,title:heading.textContent.trim(),body:chars.slice(0,maxChars).join("").trim(),truncated:chars.length>maxChars};
    },{expected:normalizeTitle(input.title),maxChars:16000});
    return {...result,sourceUrl:page.url(),capturedAt:new Date().toISOString(),method:"browser"};
  } finally {
    clearTimeout(deadline);
    if(browser)await browser.close();
  }
}

async function main() {
  const chunks=[];
  let size=0;
  for await(const chunk of process.stdin) {
    size+=chunk.length;
    if(size>8192)throw new Error("Capture input exceeds its size bound.");
    chunks.push(chunk);
  }
  const result=await capture(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  process.stdout.write(JSON.stringify(result));
}

module.exports={capture,identity,normalizeTitle,validateInput,isPublicAddress};
if(require.main===module)main().catch(error=>{
  process.stdout.write(JSON.stringify({ok:false,code:"capture_failed",message:String(error.message).slice(0,1000)}));
  process.exitCode=1;
});
