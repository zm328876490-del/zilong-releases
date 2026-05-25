// dict.js — 本地词库，页面翻译 L0 加速
// 三层拦截：精确匹配 → 正则模式 → 词级替换
(function () {
  'use strict';

  // ── 1. 精确句子映射（跨境电商高频整句）────────────────────────────────────────
  const exactMap = new Map(Object.entries({
    // 葡萄牙语 (Mercado Livre / 巴西)
    'frete grátis':                         '免运费',
    'frete gratis':                         '免运费',
    'frete grátis por ser sua primeira compra': '首单免运费',
    'frete gratis por ser sua primeira compra': '首单免运费',
    'primeira compra':                      '首单',
    'ver mais':                             '查看更多',
    'ver todos':                            '查看全部',
    'adicionar ao carrinho':                '加入购物车',
    'comprar agora':                        '立即购买',
    'sem juros':                            '无利息',
    'parcelado sem juros':                  '免息分期',
    'em até':                               '最多',
    'em outros meios':                      '其他支付方式',
    'ou':                                   '或',
    'frete':                                '运费',
    'grátis':                               '免费',
    'gratis':                               '免费',
    'mais vendidos':                        '热销榜',
    'mais vendidos da semana':              '本周热销',
    'oferta do dia':                        '今日特惠',
    'oferta':                               '优惠',
    'ofertas':                              '优惠活动',
    'cupom':                                '优惠券',
    'cupons':                               '优惠券',
    'desconto':                             '折扣',
    'promoção':                             '促销',
    'promoções':                            '促销活动',
    'novo':                                 '新品',
    'nova':                                 '新品',
    'produto novo':                         '全新商品',
    'produto usado':                        '二手商品',
    'estoque':                              '库存',
    'últimas unidades':                     '仅剩少量',
    'última unidade':                       '仅剩最后一件',
    'disponível':                           '有货',
    'indisponível':                         '无货',
    'esgotado':                             '已售罄',
    'adicionar':                            '添加',
    'compras':                              '购物',
    'envio':                                '配送',
    'entrega':                              '配送',
    'entrega grátis':                       '免费配送',
    'devoluções grátis':                    '免费退货',
    'devolução':                            '退货',
    'garantia':                             '质保',
    'meses de garantia':                    '个月质保',
    'parcelamento':                         '分期付款',
    'pagamento':                            '付款',
    'pix':                                  'Pix',
    'no pix':                               '用Pix',
    'boleto':                               '银行票据',
    'cartão de crédito':                    '信用卡',
    'mercado pago':                         'Mercado Pago',
    'mercado livre':                        'Mercado Livre',
    'favoritos':                            '收藏夹',
    'avaliar':                              '评价',
    'avaliações':                           '评价',
    'avaliação':                            '评价',
    'opiniões':                             '用户评价',
    'perguntas':                            '问答',
    'vendedor':                             '卖家',
    'loja oficial':                         '官方店铺',
    'lojas oficiais':                       '官方店铺',
    'publicidade':                          '广告',
    'patrocinado':                          '赞助',
    'anúncio':                              '广告',
    'categorias':                           '分类',
    'categoria':                            '分类',
    'buscar':                               '搜索',
    'buscar produtos, marcas e muito mais...': '搜索产品、品牌等等......',
    'minha conta':                          '我的账户',
    'minhas compras':                       '我的订单',
    'meu carrinho':                         '我的购物车',
    'notificações':                         '通知',
    'saldo no mercado pago':                'Mercado Pago 余额',
    'supermarket':                          '超市',
    'supermercado':                         '超市',
    'moda':                                 '时尚',
    'eletrodomésticos':                     '家用电器',
    'eletrônicos':                          '电子产品',
    'informática':                          '电脑数码',
    'celulares':                            '手机',
    'smartphones':                          '智能手机',
    'televisores':                          '电视',
    'geladeira':                            '冰箱',
    'máquina de lavar':                     '洗衣机',
    'ar-condicionado':                      '空调',
    'sofá':                                 '沙发',
    'livros':                               '书籍',
    'brinquedos':                           '玩具',
    'esporte':                              '运动',
    'saúde':                                '健康',
    'beleza':                               '美妆',
    'casa':                                 '家居',
    'jardim':                               '园艺',
    'automóveis':                           '汽车',
    'serviços':                             '服务',
    // 西班牙语 (Mercado Libre 其他拉美站)
    'envío gratis':                         '免运费',
    'envio gratis':                         '免运费',
    'agregar al carrito':                   '加入购物车',
    'comprar':                              '购买',
    'ver más':                              '查看更多',
    'publicado':                            '已发布',
    'nuevo':                                '全新',
    'usado':                                '二手',
    'sin interés':                          '免息',
    'cuotas sin interés':                   '免息分期',
    'devolución gratis':                    '免费退货',
    'garantía':                             '质保',
    'vendido por':                          '卖家',
    'tienda oficial':                       '官方店铺',
    // 英语 (Amazon / 速卖通)
    'add to cart':                          '加入购物车',
    'buy now':                              '立即购买',
    'free shipping':                        '免运费',
    'free delivery':                        '免费配送',
    'free returns':                         '免费退货',
    'in stock':                             '有库存',
    'out of stock':                         '无库存',
    'sold out':                             '已售罄',
    'best seller':                          '热销榜',
    'best sellers':                         '热销榜',
    'new arrival':                          '新品',
    'new arrivals':                         '新品上架',
    'limited time':                         '限时',
    'limited time offer':                   '限时优惠',
    'today\'s deal':                        '今日特惠',
    'daily deals':                          '每日特惠',
    'deal of the day':                      '今日特惠',
    'lightning deal':                       '限时秒杀',
    'sold by':                              '卖家',
    'ships from':                           '发货地',
    'returns':                              '退货',
    'warranty':                             '质保',
    'customer reviews':                     '用户评价',
    'verified purchase':                    '已验证购买',
    'top rated':                            '高分好评',
    'see more':                             '查看更多',
    'see all':                              '查看全部',
    'view all':                             '查看全部',
    'shop now':                             '立即选购',
    'learn more':                           '了解更多',
    'get it by':                            '预计到达',
    'eligible for':                         '符合条件',
    'prime':                                'Prime',
    'subscribe & save':                     '订阅省更多',
    'coupon':                               '优惠券',
    'coupons':                              '优惠券',
    'off':                                  '优惠',
    'discount':                             '折扣',
    'sale':                                 '特卖',
    'clearance':                            '清仓',
    'sponsored':                            '赞助',
    'wishlist':                             '心愿单',
    'compare':                              '对比',
    'share':                                '分享',
    'report':                               '举报',
    // 德语 (Amazon.de)
    'kostenloser versand':                  '免运费',
    'kostenlose rücksendung':               '免费退货',
    'in den einkaufswagen':                 '加入购物车',
    'jetzt kaufen':                         '立即购买',
    'auf lager':                            '有库存',
    'nicht auf lager':                      '无库存',
    'ausverkauft':                          '已售罄',
    'neu':                                  '全新',
    'gebraucht':                            '二手',
    'verkauft von':                         '卖家',
    'mehr sehen':                           '查看更多',
    // 日语 (Amazon.co.jp)
    'カートに入れる':                       '加入购物车',
    '今すぐ買う':                           '立即购买',
    '無料配送':                             '免运费',
    '在庫あり':                             '有库存',
    '在庫切れ':                             '无库存',
    '送料無料':                             '包邮',
    'ポイント':                             '积分',
    'クーポン':                             '优惠券',
    'セール':                               '特卖',
    'レビュー':                             '评价',
    'お気に入り':                           '收藏',
  }));

  // ── 2. 正则模板规则（含数字变量的句型）────────────────────────────────────────
  const patternRules = [
    // 巴西葡萄牙语
    [/^(\d+)x\s+R\$\s*([\d.,]+)\s+sem juros$/i,
      (_, n, v) => `${n}期免息，每期R$${v}`],
    [/^ou\s+R\$\s*([\d.,]+)\s+em\s+(\d+)x\s+R\$\s*([\d.,]+)\s+sem juros$/i,
      (_, total, n, each) => `或R$${total}，${n}期免息，每期R$${each}`],
    [/^(\d+)x\s+R\$\s*([\d.,]+)$/i,
      (_, n, v) => `${n}期，每期R$${v}`],
    [/^(\d+(?:[.,]\d+)?)\s*%\s*off\s+no\s+pix$/i,
      (_, pct) => `Pix支付优惠${pct}%`],
    [/^(\d+(?:[.,]\d+)?)\s*%\s*off$/i,
      (_, pct) => `优惠${pct}%`],
    [/^até\s+(\d+)\s*%\s*off$/i,
      (_, pct) => `最高优惠${pct}%`],
    [/^válido\s+até\s+(.+)$/i,
      (_, d) => `有效期至 ${d}`],
    [/^disponível\s+a\s+partir\s+de\s+(.+)$/i,
      (_, d) => `${d} 起可用`],
    [/^(\d+)\s+meses\s+de\s+garantia$/i,
      (_, n) => `${n}个月质保`],
    [/^frete\s+grátis\s+acima\s+de\s+R\$\s*([\d.,]+)$/i,
      (_, v) => `满R$${v}免运费`],
    [/^(\d+)\s*%\s*off\s+saldo\s+no\s+mercado\s+pago$/i,
      (_, pct) => `Mercado Pago余额优惠${pct}%`],
    [/^cupom\s+(\d+)\s*%\s*off$/i,
      (_, pct) => `优惠券 优惠${pct}%`],
    // 英语通用
    [/^(\d+)%\s+off$/i,
      (_, pct) => `优惠${pct}%`],
    [/^up\s+to\s+(\d+)%\s+off$/i,
      (_, pct) => `最高优惠${pct}%`],
    [/^save\s+(\d+)%$/i,
      (_, pct) => `节省${pct}%`],
    [/^(\d+)\s*-\s*month\s+warranty$/i,
      (_, n) => `${n}个月质保`],
    [/^(\d+)\s+sold$/i,
      (_, n) => `已售${n}件`],
    [/^(\d+)\s+reviews?$/i,
      (_, n) => `${n}条评价`],
    [/^(\d+)\s+ratings?$/i,
      (_, n) => `${n}个评分`],
    [/^(\d[\d,]*)\+?\s+sold$/i,
      (_, n) => `已售${n}件`],
    [/^free\s+shipping\s+on\s+orders\s+over\s+\$?([\d.,]+)$/i,
      (_, v) => `订单满$${v}免运费`],
    // 德语
    [/^(\d+)\s*%\s+rabatt$/i,
      (_, pct) => `优惠${pct}%`],
    [/^spare\s+(\d+)\s*%$/i,
      (_, pct) => `节省${pct}%`],
    // 日语
    [/^(\d+)%\s*オフ$/,
      (_, pct) => `优惠${pct}%`],
    [/^(\d+)個\s*売れました$/,
      (_, n) => `已售${n}件`],
  ];

  // ── 3. 词级替换表（作用于整句，不精确匹配时兜底润色）─────────────────────────
  const tokenMap = [
    [/\bfrete\b/gi,          '运费'],
    [/\bgrátis\b/gi,         '免费'],
    [/\bgratis\b/gi,         '免费'],
    [/\bcomprar\b/gi,        '购买'],
    [/\bcupom\b/gi,          '优惠券'],
    [/\bdesconto\b/gi,       '折扣'],
    [/\boferta\b/gi,         '优惠'],
    [/\bgarantia\b/gi,       '质保'],
    [/\bparcelado\b/gi,      '分期'],
    [/\bsem juros\b/gi,      '免息'],
    [/\benvio gratis\b/gi,   '免运费'],
    [/\benvío gratis\b/gi,   '免运费'],
    [/(\d+(?:[.,]\d+)?)\s*%\s*(?:off|OFF|descuento|rabatt)/g,
      (_, p) => `优惠${p}%`],
  ];

  function localTranslate(text) {
    var t = text.trim();
    if (!t) return null;

    // 1. 精确匹配（不区分大小写）
    var lower = t.toLowerCase();
    if (exactMap.has(lower)) return exactMap.get(lower);

    // 2. 正则模式
    for (var i = 0; i < patternRules.length; i++) {
      var re = patternRules[i][0];
      var fn = patternRules[i][1];
      var m = t.match(re);
      if (m) return typeof fn === 'function' ? fn.apply(null, m) : t.replace(re, fn);
    }

    // 3. 未命中
    return null;
  }

  function postProcess(translated) {
    var s = translated;
    for (var i = 0; i < tokenMap.length; i++) {
      s = s.replace(tokenMap[i][0], tokenMap[i][1]);
    }
    return s;
  }

  function mergeSceneDict(items) {
    if (!items) return 0;
    var count = 0;
    var insert = function (src, dst) {
      if (!src || !dst) return;
      var k = String(src).toLowerCase();
      if (!exactMap.has(k)) { exactMap.set(k, String(dst)); count++; }
    };
    if (Array.isArray(items)) {
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (Array.isArray(it)) insert(it[0], it[1]);
        else if (it && typeof it === 'object') insert(it.src, it.dst);
      }
    } else if (typeof items === 'object') {
      var keys = Object.keys(items);
      for (var j = 0; j < keys.length; j++) insert(keys[j], items[keys[j]]);
    }
    return count;
  }

  window.__ai_dict = {
    localTranslate: localTranslate,
    postProcess: postProcess,
    mergeSceneDict: mergeSceneDict,
  };
})();
