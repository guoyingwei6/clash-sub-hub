//==========================================================================
/*
 * Clash Verge (Mihomo/Meta) 高级分流脚本 - 学术与 AI 增强版
 * 👨‍💻 作者：Yingwei Guo (@guoyingwei6)
 * 📅 更新日期：2026.05.20
 *
 * ✨ 核心特性：
 * 1. 🧹 节点管理无忧：automatic additional-prefix 前缀隔离，多机场订阅节点永不冲突，订阅导入即用。
 * 2. 🚀 性能极致优化：启用 Unified Delay、TCP 并发、Fast Open，强制 geodata 内存极简匹配，速度与延迟双巅峰。
 * 3. 🎯 多维精准分流：深度集成 Loyalsoldier 与 Blackmatrix7 规则，涵盖广告拦截、社交媒体与谷歌服务，内置 24h 自动同步，分流逻辑与全球 IP 段始终最新。
 * 4. 🌐 AI极净安全链路：强制美国家宽链式中转 + 自建 Reality 故障切换，搭配自部署 DoH 服务器，双层隔离防封号、防 DNS 污染/劫持。
 * 5. 🔬 学术专属直连：深度整合主流期刊域名 + Zotero/EndNote 进程识别，确保机构 IP 导出，实现论文全文自动下载。
 * 6. 🔒 安全解耦·动态适配：订阅链接与节点凭据通过 Merge 注入，脚本不含敏感信息可安全开源；同时自动检测自建/家宽节点是否存在，按需生成分组，零手动干预。
 *
 * 使用方法：
 *   - 将本脚本设置为 Clash Verge 的「全局扩展脚本」(Script)
 *   - 在「全局扩展覆写配置」(Merge) 中填写你的 proxy-providers（机场订阅）和 proxies（自建节点）
 *   - Merge 模板参见 README
 *
 * 更新日志：
 * 2026-05-20：TUN 新增 exclude-route 排除 10.0.0.0/8，修复内网 SSH 等流量被 TUN 劫持问题
 * 2026-05-19：新增「家宽中转」分组，排除 CF 系机场节点，修复家宽链式中转随机 timeout 问题；新增自建 TUIC 节点支持，「优先自建」fallback 顺序改为 Reality → TUIC → 自动选择
 * 2026-04-21：proxy-server-nameserver 改用国内 DNS 防止节点解析死循环；新增 direct-nameserver-follow-policy: true
 * 2026-04-10：启用 strict-route: true 防止 mDNSResponder 绕过 TUN 导致 DNS 泄露；新增 dns-hijack 劫持所有 UDP/TCP 53 查询
 * 2026-04-01：新增 TUN 显式配置；stack 改为 system 模式提升兼容性；MTU 调整为 1400 修复微信图片等大包发送失败问题
 * 2026-03-30：敏感信息分离至 Merge 配置；动态检测自建/家宽节点
 * 2026-03-19：修复dns循环解析问题；删除冗余配置；优化分组顺序
 * 2026-03-16：更新脚本介绍信息
 */
//==========================================================================

function main(config) {
  // 1. 防崩溃初始化
  config = config || {};
  config.proxies = config.proxies || [];
  config["proxy-groups"] = config["proxy-groups"] || [];
  config["proxy-providers"] = config["proxy-providers"] || {};
  config["rule-providers"] = config["rule-providers"] || {};
  config.rules = config.rules || [];

  // ======================== Sniffer ========================
  config.sniffer = {
    enable: true,
    "force-dns-mapping": true,
    "parse-pure-ip": true,
    "override-destination": true,
    "sniff": {
      "HTTP": { "ports": [80, "8080-8880"] },
      "TLS":  { "ports": [443, 8443] }
    }
  };
// ======================== TUN 模式 ========================
  config.tun = {
    enable: true,
    stack: "system",        // system 模式兼容性最佳，避免 gvisor/mixed 对部分网站的兼容问题
    "auto-route": true,
    "auto-detect-interface": true,
    "strict-route": true,   // ← 加这个，放宽路由限制
    "dns-hijack": ["any:53", "tcp://any:53"], //强制劫持所有UDP/TCP53查询
    "exclude-route": ["10.0.0.0/8"],   //绕过本地内网
    mtu: 1400               // 降低 MTU 防止大包丢失（默认 1500 会导致微信图片等大文件发送失败）
  };

  // ======================== 全局性能优化 ========================
  config["find-process-mode"] = "strict";
  config["unified-delay"] = true;
  config["tcp-fast-open"] = true;
  config["tcp-concurrent"] = true;
  config["ipv6"] = false;
  config["profile"] = config["profile"] || {};
  config["profile"]["store-selected"] = true;

  // ======================== 内存优化 ========================
  config["geodata-loader"] = "memconservative";
  config["geosite-matcher"] = "succinct";

  // ======================== 从 Merge 动态读取 ========================
  const providerNames = Object.keys(config["proxy-providers"] || {});

  // 动态检测自建节点和家宽节点是否存在（由 Merge 注入）
  const hasSelfBuilt = config.proxies.some(p => p.name === "🛠 自建-Reality");
  const hasISP = config.proxies.some(p => p.name === "🏠 家宽-ISP");
  const hasTUIC = config.proxies.some(p => p.name === "🛠 自建-TUIC");

  // DNS
  const domesticNameservers = ["https://223.5.5.5/dns-query", "https://doh.pub/dns-query", "https://dns.alidns.com/dns-query"];
  const foreignNameservers  = ["https://doh.guoyingwei.top/dns-query", "https://dns.guoyingwei.top/1:-P8_P5Gwnk1_pv__tt__X__72N3-8zEA6_sAyA==", "https://1.1.1.1/dns-query", "https://1.0.0.1/dns-query", "https://dns.quad9.net/dns-query", "https://8.8.8.8/dns-query", "https://208.67.222.222/dns-query", "https://77.88.8.8/dns-query", "https://8.8.4.4/dns-query"];

  // 自定义域名后缀
  const customDomainSuffix = {
    "谷歌服务": ["antigravity-unleash.goog"],
    "YouTube": [],
    "电报消息": [],
    "AI": [
      "duckduckgo.com",
      "minimaxi.com", "minimax.chat",
      "anthropic.com",
      "claudeusercontent.com",
      "clau.de",
      "claude.com",
      "claude.ai",
      "openai.com",
      "chatgpt.com",
      "oaistatic.com",
      "oaiusercontent.com",
      "x.ai",
      "gemini.google.com",
      "gemini.googleapis.com",
      "generativelanguage.googleapis.com",
      "generativeai.google",
      "ai.google.dev",
      "grok.com",
      "perplexity.ai",
    ],
    "TikTok": [],
    "X(Twitter)": [],
    "微软服务": [],
    "苹果服务": [],
    "节点选择": [
      "cloudflare.com"
    ],
    "全局直连": [
      "naixi.net",
      "ncbi.nlm.nih.gov",
      "pubmed.ncbi.nlm.nih.gov",
      "arxiv.org",
      "sciencedirect.com",
      "elsevier.com",
      "oup.com",
      "academic.oup.com",
      "nature.com",
      "science.org",
      "sciencemag.org",
      "springer.com",
      "link.springer.com",
      "wiley.com",
      "onlinelibrary.wiley.com",
      "ieee.org",
      "acm.org",
      "jstor.org",
      "sagepub.com",
      "tandfonline.com",
      "mdpi.com",
      "acs.org",
      "rsc.org",
      "plos.org",
      "cell.com",
      "pnas.org",
      "biorxiv.org",
      "medrxiv.org",
      "researchgate.net",
      "semanticscholar.org",
      "webofscience.com",
      "scopus.com",
      "doi.org",
      "crossref.org",
      "unpaywall.org",
      "cnki.net",
      "wanfangdata.com.cn",
      "cqvip.com",
    ],
    "漏网之鱼": []
  };

  // ======================== 以下为逻辑处理 ========================

  // DNS 配置
  config.dns = {
    enable: true,
    listen: "0.0.0.0:1053",
    ipv6: false,
    "prefer-h3": false,
    "respect-rules": true,
    "use-system-hosts": false,
    "cache-algorithm": "arc",
    "enhanced-mode": "fake-ip",
    "fake-ip-range": "198.18.0.1/16",
    "fake-ip-filter": [
      "+.openai.com",
      "+.oaistatic.com",
      "+.oaiusercontent.com",
      "+.chatgpt.com",
      "+.auth0.com",
      "+.lan", "+.local", "+.msftconnecttest.com", "+.msftncsi.com",
      "localhost.ptlogin2.qq.com", "localhost.sec.qq.com",
      "+.in-addr.arpa", "+.ip6.arpa",
      "time.*.com", "time.*.gov",
      "+.qq.com", "+.wx.qq.com",
      "+.qpic.cn",
      "+.qlogo.cn",
      "+.weixin.qq.com",
      "+.wxqlogo.cn",
      "+.wechat.com",
      "+.wechat.com.cn",
      "pool.ntp.org", "localhost.work.weixin.qq.com", "+.ntp.org",
      "captive.apple.com",
      "connectivitycheck.gstatic.com",
      "detectportal.firefox.com",
      "nmcheck.gnome.org",
      "www.msftconnecttest.com",
      "www.msftncsi.com",
      "+.wps.cn",
      "+.wpscdn.cn",
      "+.ksord.com",
      "+.wps.com",
      "+.kdocs.cn",
      "oauth2.googleapis.com",
      "accounts.google.com",
      "clients1.google.com",
      "clients2.google.com"
    ],
    "default-nameserver": ["223.5.5.5", "119.29.29.29"],
    nameserver: [...foreignNameservers],
    "proxy-server-nameserver": [...domesticNameservers],
    //"direct-nameserver": [...domesticNameservers],
    //"direct-nameserver-follow-policy": true,
    "nameserver-policy": {
      "geosite:private,cn": domesticNameservers,
      "geosite:google,youtube,openai,netflix,claude,tiktok,gemini,anthropic,perplexity": foreignNameservers,
      "+.claude.ai,+.x.ai,+.gemini.googleapis.com,+.generativelanguage.googleapis.com,+.perplexity.ai": foreignNameservers,
      "+.nature.com,+.sciencedirect.com,+.springer.com,+.ieee.org,+.wiley.com,+.arxiv.org": domesticNameservers
    }
  };

  // 批量生成 rule-providers
  const rpBase = {
    type: "http",
    format: "yaml",
    interval: 86400
  };

  const rpList = [
    { name: "reject",        behavior: "domain",    src: "Loyalsoldier/clash-rules@release/reject.txt",        path: "loyalsoldier/reject.yaml" },
    { name: "apple",         behavior: "domain",    src: "Loyalsoldier/clash-rules@release/apple.txt",         path: "loyalsoldier/apple.yaml" },
    { name: "Microsoft",     behavior: "classical", src: "blackmatrix7/ios_rule_script@master/rule/Clash/Microsoft/Microsoft.yaml", path: "blackmatrix7/Microsoft.yaml" },
    { name: "google",        behavior: "classical", src: "blackmatrix7/ios_rule_script@master/rule/Clash/Google/Google.yaml",        path: "blackmatrix7/google.yaml" },
    { name: "proxy",         behavior: "domain",    src: "Loyalsoldier/clash-rules@release/proxy.txt",         path: "loyalsoldier/proxy.yaml" },
    { name: "direct",        behavior: "domain",    src: "Loyalsoldier/clash-rules@release/direct.txt",        path: "loyalsoldier/direct.yaml" },
    { name: "private",       behavior: "domain",    src: "Loyalsoldier/clash-rules@release/private.txt",       path: "loyalsoldier/private.yaml" },
    { name: "gfw",           behavior: "domain",    src: "Loyalsoldier/clash-rules@release/gfw.txt",           path: "loyalsoldier/gfw.yaml" },
    { name: "tld-not-cn",    behavior: "domain",    src: "Loyalsoldier/clash-rules@release/tld-not-cn.txt",    path: "loyalsoldier/tld-not-cn.yaml" },
    { name: "telegramcidr",  behavior: "ipcidr",    src: "Loyalsoldier/clash-rules@release/telegramcidr.txt",  path: "loyalsoldier/telegramcidr.yaml" },
    { name: "cncidr",        behavior: "ipcidr",    src: "Loyalsoldier/clash-rules@release/cncidr.txt",        path: "loyalsoldier/cncidr.yaml" },
    { name: "lancidr",       behavior: "ipcidr",    src: "Loyalsoldier/clash-rules@release/lancidr.txt",       path: "loyalsoldier/lancidr.yaml" },
    { name: "applications",  behavior: "classical", src: "Loyalsoldier/clash-rules@release/applications.txt",  path: "loyalsoldier/applications.yaml" },
    { name: "Twitter",       behavior: "classical", src: "blackmatrix7/ios_rule_script@master/rule/Clash/Twitter/Twitter.yaml",     path: "blackmatrix7/Twitter.yaml" },
    { name: "YouTube",       behavior: "classical", src: "blackmatrix7/ios_rule_script@master/rule/Clash/YouTube/YouTube.yaml",      path: "blackmatrix7/YouTube.yaml" },
    { name: "AI",            behavior: "classical", src: "blackmatrix7/ios_rule_script@master/rule/Clash/OpenAI/OpenAI.yaml",       path: "blackmatrix7/OpenAI.yaml" },
    { name: "TikTok",        behavior: "classical", src: "blackmatrix7/ios_rule_script@master/rule/Clash/TikTok/TikTok.yaml",        path: "blackmatrix7/TikTok.yaml" },
  ];

  rpList.forEach(r => {
    config["rule-providers"][r.name] = {
      ...rpBase,
      behavior: r.behavior,
      url: `https://fastly.jsdelivr.net/gh/${r.src}`,
      path: `./ruleset/${r.path}`
    };
  });

  // 通用分组选项
  const groupBase = {
    interval: 300,
    timeout: 3000,
    url: "https://www.gstatic.com/generate_204",
    lazy: true,
    "max-failed-times": 3,
    hidden: false
  };
  const commonProxies = ["优先自建", "⚡️ 自动选择", "节点选择", ...(hasISP ? ["🏠 家宽"] : []), "全局直连"];
  const iconBase = "https://fastly.jsdelivr.net/gh/";

  // 优先自建 fallback 组：没有自建节点就只剩自动选择
  const prioritySelfBuiltGroup = {
    name: "优先自建",
    type: "fallback",
    proxies: [
      ...(hasSelfBuilt ? ["🛠 自建-Reality"] : []),
      ...(hasTUIC ? ["🛠 自建-TUIC"] : []),
      "⚡️ 自动选择"
    ],
    url: "https://www.gstatic.com/generate_204",
    interval: 300,
    lazy: true,
    icon: "clash-verge-rev/clash-verge-rev.github.io@main/docs/assets/icons/guard.svg"
  };

  // proxy-groups
  const groups = [
    {
      name: "⚡️ 自动选择",
      type: "url-test",
      tolerance: 80,
      proxies: [],
      use: providerNames,
      filter: "^(?!.*(官网|套餐|流量|异常|剩余|ISP|all|免费|低倍率|0\\.[0-9]x|测试|到期)).*$",
      icon: "clash-verge-rev/clash-verge-rev.github.io@main/docs/assets/icons/speed.svg"
    },
    {
      name: "节点选择",
      type: "select",
      proxies: [...(hasISP ? ["🏠 家宽"] : []), "优先自建", "⚡️ 自动选择", "全局直连"],
      icon: "clash-verge-rev/clash-verge-rev.github.io@main/docs/assets/icons/adjust.svg"
    },
    prioritySelfBuiltGroup,
    // 家宽组：只在检测到 ISP 节点时才创建
    ...(hasISP ? [{
      name: "🏠 家宽",
      type: "select",
      proxies: ["🏠 家宽-ISP"],
      icon: "clash-verge-rev/clash-verge-rev.github.io@main/docs/assets/icons/openwrt.svg"
    }] : []),
    // 家宽中转：只在检测到 ISP 节点时才创建，同时避免用CF搭建的节点代理
    ...(hasISP ? [{
      name: "🚇 家宽中转",
      type: "url-test",
      tolerance: 100,
      use: providerNames,
      filter: "^(?!.*(BPB|cfnew|Edge|自建|官网|套餐|流量|异常|剩余|ISP|all|免费|低倍率|0\\.[0-9]x|测试|到期)).*(日本|香港|韩国|台湾|美国|JP|HK|KR|TW|US).*$",
      icon: "clash-verge-rev/clash-verge-rev.github.io@main/docs/assets/icons/ambulance.svg"
    }] : []),
    { name: "谷歌服务", proxies: commonProxies, icon: "clash-verge-rev/clash-verge-rev.github.io@main/docs/assets/icons/google.svg" },
    { name: "YouTube", proxies: commonProxies, icon: "clash-verge-rev/clash-verge-rev.github.io@main/docs/assets/icons/youtube.svg" },
    { name: "电报消息", proxies: commonProxies, icon: "clash-verge-rev/clash-verge-rev.github.io@main/docs/assets/icons/telegram.svg" },
    {
      name: "AI",
      proxies: [...(hasISP ? ["🏠 家宽"] : []), "优先自建", "⚡️ 自动选择", "节点选择"],
      icon: "clash-verge-rev/clash-verge-rev.github.io@main/docs/assets/icons/chatgpt.svg"
    },
    { name: "TikTok", proxies: commonProxies, icon: "xiaolin-007/clash@main/icon/tiktok.svg" },
    { name: "X(Twitter)", proxies: commonProxies, icon: "https://abs.twimg.com/responsive-web/client-web/icon-svg.ea5ff4aa.svg", isFullUrl: true },
    { name: "微软服务", proxies: ["全局直连", "⚡️ 自动选择", "节点选择"], icon: "clash-verge-rev/clash-verge-rev.github.io@main/docs/assets/icons/microsoft.svg" },
    { name: "苹果服务", proxies: commonProxies, icon: "clash-verge-rev/clash-verge-rev.github.io@main/docs/assets/icons/apple.svg" },
    { name: "邮件", proxies: ["节点选择", "优先自建", "⚡️ 自动选择"], icon: "clash-verge-rev/clash-verge-rev.github.io@main/docs/assets/icons/embedded.svg" },
    { name: "广告过滤", proxies: ["REJECT", "DIRECT"], icon: "clash-verge-rev/clash-verge-rev.github.io@main/docs/assets/icons/bug.svg" },
    { name: "全局直连", proxies: ["DIRECT", "⚡️ 自动选择"], icon: "clash-verge-rev/clash-verge-rev.github.io@main/docs/assets/icons/link.svg" },
    { name: "全局拦截", proxies: ["REJECT", "DIRECT"], icon: "clash-verge-rev/clash-verge-rev.github.io@main/docs/assets/icons/block.svg" },
    { name: "漏网之鱼", proxies: ["⚡️ 自动选择", "全局直连", "DIRECT"], icon: "clash-verge-rev/clash-verge-rev.github.io@main/docs/assets/icons/fish.svg" }
  ];

  groups.forEach(g => {
    const icon = g.isFullUrl ? g.icon : (g.icon ? iconBase + g.icon : undefined);
    config["proxy-groups"].push({ ...groupBase, ...g, icon, type: g.type || "select" });
  });

  // 规则：先加自定义域名（优先级最高），再加基础规则
  Object.entries(customDomainSuffix).forEach(([group, domains]) => {
    domains.forEach(d => {
      if (d.trim()) config.rules.push(`DOMAIN-SUFFIX,${d},${group}`);
    });
  });

  config.rules.push(
    "RULE-SET,AI,AI",
    "PROCESS-NAME,Claude.exe,AI",
    "PROCESS-NAME,Cursor.exe,AI",
    "PROCESS-NAME,ChatGPT.exe,AI",
    "PROCESS-NAME,ChatGPTHelper,AI",
    "PROCESS-NAME,ChatGPT,AI",
    "PROCESS-NAME,claude,AI",
    "PROCESS-NAME,cursor,AI",
    "PROCESS-NAME,Claude Helper,AI",
    //微信直连
    "PROCESS-NAME,WeChat,全局直连",
    "PROCESS-NAME,wechat,全局直连",
    "PROCESS-NAME,wechatappex,全局直连",
    "PROCESS-NAME,OneDrive,全局直连",
    // 学术工具进程直连
    "PROCESS-NAME,zotero.exe,全局直连",
    "PROCESS-NAME,zotero,全局直连",
    "PROCESS-NAME,EndNote.exe,全局直连",
    "PROCESS-NAME,EndNote,全局直连",
    "PROCESS-NAME,wpsoffice,优先自建",
    "PROCESS-NAME,wpscloudsvr,优先自建",
    "RULE-SET,applications,全局直连",
    "RULE-SET,private,全局直连",
    "DOMAIN-SUFFIX,googleapis.cn,节点选择",
    "DOMAIN-SUFFIX,gstatic.com,节点选择",
    "DOMAIN-SUFFIX,xn--ngstr-lra8j.com,节点选择",
    "DOMAIN-SUFFIX,github.io,节点选择",
    "DOMAIN,v2rayse.com,节点选择",
    "DOMAIN-SUFFIX,gmail.com,邮件",
    "DOMAIN-SUFFIX,googlemail.com,邮件",
    "RULE-SET,reject,广告过滤",
    "RULE-SET,Microsoft,微软服务",
    "RULE-SET,apple,苹果服务",
    "RULE-SET,YouTube,YouTube",
    "RULE-SET,TikTok,TikTok",
    "RULE-SET,Twitter,X(Twitter)",
    "RULE-SET,google,谷歌服务",
    "RULE-SET,proxy,优先自建",
    "RULE-SET,gfw,优先自建",
    "RULE-SET,tld-not-cn,优先自建",
    "RULE-SET,direct,全局直连",
    "RULE-SET,lancidr,全局直连,no-resolve",
    "RULE-SET,cncidr,全局直连,no-resolve",
    "AND,((NETWORK,UDP),(DST-PORT,443)),REJECT",
    "RULE-SET,telegramcidr,电报消息,no-resolve",
    "GEOSITE,CN,全局直连",
    "GEOIP,LAN,全局直连,no-resolve",
    "GEOIP,CN,全局直连,no-resolve",
    "MATCH,漏网之鱼"
  );

  return config;
}

// ES module export for Workers static import
export { main };
