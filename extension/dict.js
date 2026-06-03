// dict.js — 本地词库，页面翻译 L0 加速
// ~70 条全站通用 UI 词 × 11 种目标语言，覆盖导航/操作/状态/电商/页脚/时间/社交
(function () {
  'use strict';

  if (location.href.indexOf('chrome-extension://') === 0) return;

  // ── 多语言 UI 词典（key=英文小写，value={目标语言:译文}）─────────────
  const uiDict = {
    // 导航
    'menu':       {'zh-Hans':'菜单','zh-Hant':'選單','ja':'メニュー','ko':'메뉴','fr':'Menu','de':'Menü','es':'Menú','pt':'Menu','ru':'Меню','th':'เมนู','vi':'Menu','en':'Menu'},
    'search':     {'zh-Hans':'搜索','zh-Hant':'搜尋','ja':'検索','ko':'검색','fr':'Rechercher','de':'Suche','es':'Buscar','pt':'Pesquisar','ru':'Поиск','th':'ค้นหา','vi':'Tìm kiếm','en':'Search'},
    'close':      {'zh-Hans':'关闭','zh-Hant':'關閉','ja':'閉じる','ko':'닫기','fr':'Fermer','de':'Schließen','es':'Cerrar','pt':'Fechar','ru':'Закрыть','th':'ปิด','vi':'Đóng','en':'Close'},
    'back':       {'zh-Hans':'返回','zh-Hant':'返回','ja':'戻る','ko':'뒤로','fr':'Retour','de':'Zurück','es':'Atrás','pt':'Voltar','ru':'Назад','th':'ย้อนกลับ','vi':'Quay lại','en':'Back'},
    'next':       {'zh-Hans':'下一步','zh-Hant':'下一步','ja':'次へ','ko':'다음','fr':'Suivant','de':'Weiter','es':'Siguiente','pt':'Próximo','ru':'Далее','th':'ถัดไป','vi':'Tiếp','en':'Next'},
    'previous':   {'zh-Hans':'上一步','zh-Hant':'上一步','ja':'前へ','ko':'이전','fr':'Précédent','de':'Zurück','es':'Anterior','pt':'Anterior','ru':'Назад','th':'ก่อนหน้า','vi':'Trước','en':'Previous'},
    'home':       {'zh-Hans':'首页','zh-Hant':'首頁','ja':'ホーム','ko':'홈','fr':'Accueil','de':'Startseite','es':'Inicio','pt':'Início','ru':'Главная','th':'หน้าแรก','vi':'Trang chủ','en':'Home'},
    'top':        {'zh-Hans':'顶部','zh-Hant':'頂部','ja':'トップ','ko':'맨 위','fr':'Haut','de':'Oben','es':'Arriba','pt':'Topo','ru':'Вверх','th':'บนสุด','vi':'Đầu trang','en':'Top'},
    'skip':       {'zh-Hans':'跳过','zh-Hant':'跳過','ja':'スキップ','ko':'건너뛰기','fr':'Passer','de':'Überspringen','es':'Saltar','pt':'Pular','ru':'Пропустить','th':'ข้าม','vi':'Bỏ qua','en':'Skip'},

    // 操作
    'submit':     {'zh-Hans':'提交','zh-Hant':'提交','ja':'送信','ko':'제출','fr':'Envoyer','de':'Absenden','es':'Enviar','pt':'Enviar','ru':'Отправить','th':'ส่ง','vi':'Gửi','en':'Submit'},
    'cancel':     {'zh-Hans':'取消','zh-Hant':'取消','ja':'キャンセル','ko':'취소','fr':'Annuler','de':'Abbrechen','es':'Cancelar','pt':'Cancelar','ru':'Отмена','th':'ยกเลิก','vi':'Hủy','en':'Cancel'},
    'save':       {'zh-Hans':'保存','zh-Hant':'儲存','ja':'保存','ko':'저장','fr':'Enregistrer','de':'Speichern','es':'Guardar','pt':'Salvar','ru':'Сохранить','th':'บันทึก','vi':'Lưu','en':'Save'},
    'delete':     {'zh-Hans':'删除','zh-Hant':'刪除','ja':'削除','ko':'삭제','fr':'Supprimer','de':'Löschen','es':'Eliminar','pt':'Excluir','ru':'Удалить','th':'ลบ','vi':'Xóa','en':'Delete'},
    'edit':       {'zh-Hans':'编辑','zh-Hant':'編輯','ja':'編集','ko':'편집','fr':'Modifier','de':'Bearbeiten','es':'Editar','pt':'Editar','ru':'Редактировать','th':'แก้ไข','vi':'Chỉnh sửa','en':'Edit'},
    'add':        {'zh-Hans':'添加','zh-Hant':'新增','ja':'追加','ko':'추가','fr':'Ajouter','de':'Hinzufügen','es':'Añadir','pt':'Adicionar','ru':'Добавить','th':'เพิ่ม','vi':'Thêm','en':'Add'},
    'remove':     {'zh-Hans':'移除','zh-Hant':'移除','ja':'削除','ko':'제거','fr':'Retirer','de':'Entfernen','es':'Quitar','pt':'Remover','ru':'Удалить','th':'ลบออก','vi':'Xóa','en':'Remove'},
    'confirm':    {'zh-Hans':'确认','zh-Hant':'確認','ja':'確認','ko':'확인','fr':'Confirmer','de':'Bestätigen','es':'Confirmar','pt':'Confirmar','ru':'Подтвердить','th':'ยืนยัน','vi':'Xác nhận','en':'Confirm'},
    'sign in':    {'zh-Hans':'登录','zh-Hant':'登入','ja':'ログイン','ko':'로그인','fr':'Connexion','de':'Anmelden','es':'Iniciar sesión','pt':'Entrar','ru':'Войти','th':'เข้าสู่ระบบ','vi':'Đăng nhập','en':'Sign In'},
    'sign up':    {'zh-Hans':'注册','zh-Hant':'註冊','ja':'新規登録','ko':'회원가입','fr':'Inscription','de':'Registrieren','es':'Registrarse','pt':'Cadastrar','ru':'Регистрация','th':'สมัคร','vi':'Đăng ký','en':'Sign Up'},
    'log in':     {'zh-Hans':'登录','zh-Hant':'登入','ja':'ログイン','ko':'로그인','fr':'Connexion','de':'Anmelden','es':'Acceder','pt':'Entrar','ru':'Войти','th':'เข้าสู่ระบบ','vi':'Đăng nhập','en':'Log In'},
    'log out':    {'zh-Hans':'退出','zh-Hant':'登出','ja':'ログアウト','ko':'로그아웃','fr':'Déconnexion','de':'Abmelden','es':'Salir','pt':'Sair','ru':'Выйти','th':'ออกจากระบบ','vi':'Đăng xuất','en':'Log Out'},
    'login':      {'zh-Hans':'登录','zh-Hant':'登入','ja':'ログイン','ko':'로그인','fr':'Connexion','de':'Anmelden','es':'Acceso','pt':'Login','ru':'Вход','th':'เข้าสู่ระบบ','vi':'Đăng nhập','en':'Login'},
    'register':   {'zh-Hans':'注册','zh-Hant':'註冊','ja':'登録','ko':'등록','fr':'Inscription','de':'Registrierung','es':'Registro','pt':'Registro','ru':'Регистрация','th':'ลงทะเบียน','vi':'Đăng ký','en':'Register'},
    'download':   {'zh-Hans':'下载','zh-Hant':'下載','ja':'ダウンロード','ko':'다운로드','fr':'Télécharger','de':'Herunterladen','es':'Descargar','pt':'Baixar','ru':'Скачать','th':'ดาวน์โหลด','vi':'Tải xuống','en':'Download'},
    'upload':     {'zh-Hans':'上传','zh-Hant':'上傳','ja':'アップロード','ko':'업로드','fr':'Téléverser','de':'Hochladen','es':'Subir','pt':'Enviar','ru':'Загрузить','th':'อัปโหลด','vi':'Tải lên','en':'Upload'},
    'filter':     {'zh-Hans':'筛选','zh-Hant':'篩選','ja':'フィルター','ko':'필터','fr':'Filtrer','de':'Filter','es':'Filtrar','pt':'Filtrar','ru':'Фильтр','th':'ตัวกรอง','vi':'Lọc','en':'Filter'},
    'sort':       {'zh-Hans':'排序','zh-Hant':'排序','ja':'並び替え','ko':'정렬','fr':'Trier','de':'Sortieren','es':'Ordenar','pt':'Ordenar','ru':'Сортировка','th':'เรียง','vi':'Sắp xếp','en':'Sort'},
    'clear':      {'zh-Hans':'清除','zh-Hant':'清除','ja':'クリア','ko':'지우기','fr':'Effacer','de':'Löschen','es':'Limpiar','pt':'Limpar','ru':'Очистить','th':'ล้าง','vi':'Xóa','en':'Clear'},
    'reset':      {'zh-Hans':'重置','zh-Hant':'重設','ja':'リセット','ko':'초기화','fr':'Réinitialiser','de':'Zurücksetzen','es':'Restablecer','pt':'Redefinir','ru':'Сброс','th':'รีเซ็ต','vi':'Đặt lại','en':'Reset'},
    'refresh':    {'zh-Hans':'刷新','zh-Hant':'重新整理','ja':'更新','ko':'새로고침','fr':'Actualiser','de':'Aktualisieren','es':'Actualizar','pt':'Atualizar','ru':'Обновить','th':'รีเฟรช','vi':'Làm mới','en':'Refresh'},
    'copy':       {'zh-Hans':'复制','zh-Hant':'複製','ja':'コピー','ko':'복사','fr':'Copier','de':'Kopieren','es':'Copiar','pt':'Copiar','ru':'Копировать','th':'คัดลอก','vi':'Sao chép','en':'Copy'},
    'paste':      {'zh-Hans':'粘贴','zh-Hant':'貼上','ja':'貼り付け','ko':'붙여넣기','fr':'Coller','de':'Einfügen','es':'Pegar','pt':'Colar','ru':'Вставить','th':'วาง','vi':'Dán','en':'Paste'},
    'print':      {'zh-Hans':'打印','zh-Hant':'列印','ja':'印刷','ko':'인쇄','fr':'Imprimer','de':'Drucken','es':'Imprimir','pt':'Imprimir','ru':'Печать','th':'พิมพ์','vi':'In','en':'Print'},
    'send':       {'zh-Hans':'发送','zh-Hant':'傳送','ja':'送信','ko':'보내기','fr':'Envoyer','de':'Senden','es':'Enviar','pt':'Enviar','ru':'Отправить','th':'ส่ง','vi':'Gửi','en':'Send'},

    // 展示交互
    'read more':  {'zh-Hans':'阅读更多','zh-Hant':'閱讀更多','ja':'続きを読む','ko':'더 읽기','fr':'Lire la suite','de':'Weiterlesen','es':'Leer más','pt':'Ler mais','ru':'Читать далее','th':'อ่านต่อ','vi':'Đọc thêm','en':'Read More'},
    'learn more': {'zh-Hans':'了解更多','zh-Hant':'了解更多','ja':'詳細を見る','ko':'자세히 보기','fr':'En savoir plus','de':'Mehr erfahren','es':'Más información','pt':'Saiba mais','ru':'Узнать больше','th':'ดูเพิ่มเติม','vi':'Tìm hiểu thêm','en':'Learn More'},
    'view all':   {'zh-Hans':'查看全部','zh-Hant':'檢視全部','ja':'すべて見る','ko':'전체 보기','fr':'Voir tout','de':'Alle anzeigen','es':'Ver todo','pt':'Ver tudo','ru':'Смотреть все','th':'ดูทั้งหมด','vi':'Xem tất cả','en':'View All'},
    'see more':   {'zh-Hans':'查看更多','zh-Hant':'查看更多','ja':'もっと見る','ko':'더 보기','fr':'Voir plus','de':'Mehr sehen','es':'Ver más','pt':'Ver mais','ru':'Смотреть больше','th':'ดูเพิ่ม','vi':'Xem thêm','en':'See More'},
    'see all':    {'zh-Hans':'查看全部','zh-Hant':'檢視全部','ja':'すべて見る','ko':'전체 보기','fr':'Voir tout','de':'Alle sehen','es':'Ver todo','pt':'Ver todos','ru':'Смотреть все','th':'ดูทั้งหมด','vi':'Xem tất cả','en':'See All'},
    'show more':  {'zh-Hans':'显示更多','zh-Hant':'顯示更多','ja':'もっと表示','ko':'더 표시','fr':'Afficher plus','de':'Mehr anzeigen','es':'Mostrar más','pt':'Mostrar mais','ru':'Показать больше','th':'แสดงเพิ่ม','vi':'Hiện thêm','en':'Show More'},
    'show less':  {'zh-Hans':'收起','zh-Hant':'收起','ja':'一部を表示','ko':'간략히','fr':'Afficher moins','de':'Weniger anzeigen','es':'Mostrar menos','pt':'Mostrar menos','ru':'Показать меньше','th':'แสดงน้อยลง','vi':'Ẩn bớt','en':'Show Less'},
    'load more':  {'zh-Hans':'加载更多','zh-Hant':'載入更多','ja':'もっと読み込む','ko':'더 불러오기','fr':'Charger plus','de':'Mehr laden','es':'Cargar más','pt':'Carregar mais','ru':'Загрузить еще','th':'โหลดเพิ่ม','vi':'Tải thêm','en':'Load More'},
    'preview':    {'zh-Hans':'预览','zh-Hant':'預覽','ja':'プレビュー','ko':'미리보기','fr':'Aperçu','de':'Vorschau','es':'Vista previa','pt':'Pré-visualizar','ru':'Предпросмотр','th':'ตัวอย่าง','vi':'Xem trước','en':'Preview'},
    'details':    {'zh-Hans':'详情','zh-Hant':'詳細','ja':'詳細','ko':'상세','fr':'Détails','de':'Details','es':'Detalles','pt':'Detalhes','ru':'Подробнее','th':'รายละเอียด','vi':'Chi tiết','en':'Details'},

    // 状态
    'loading':    {'zh-Hans':'加载中','zh-Hant':'載入中','ja':'読み込み中','ko':'로딩 중','fr':'Chargement','de':'Laden','es':'Cargando','pt':'Carregando','ru':'Загрузка','th':'กำลังโหลด','vi':'Đang tải','en':'Loading'},
    'error':      {'zh-Hans':'错误','zh-Hant':'錯誤','ja':'エラー','ko':'오류','fr':'Erreur','de':'Fehler','es':'Error','pt':'Erro','ru':'Ошибка','th':'ข้อผิดพลาด','vi':'Lỗi','en':'Error'},
    'success':    {'zh-Hans':'成功','zh-Hant':'成功','ja':'成功','ko':'성공','fr':'Succès','de':'Erfolg','es':'Éxito','pt':'Sucesso','ru':'Успешно','th':'สำเร็จ','vi':'Thành công','en':'Success'},
    'no results': {'zh-Hans':'无结果','zh-Hant':'無結果','ja':'結果なし','ko':'결과 없음','fr':'Aucun résultat','de':'Keine Ergebnisse','es':'Sin resultados','pt':'Sem resultados','ru':'Нет результатов','th':'ไม่พบผลลัพธ์','vi':'Không có kết quả','en':'No Results'},
    'not found':  {'zh-Hans':'未找到','zh-Hant':'未找到','ja':'見つかりません','ko':'찾을 수 없음','fr':'Introuvable','de':'Nicht gefunden','es':'No encontrado','pt':'Não encontrado','ru':'Не найдено','th':'ไม่พบ','vi':'Không tìm thấy','en':'Not Found'},
    'coming soon':{'zh-Hans':'敬请期待','zh-Hant':'敬請期待','ja':'近日公開','ko':'곧 출시','fr':'Bientôt','de':'Demnächst','es':'Próximamente','pt':'Em breve','ru':'Скоро','th':'เร็วๆ นี้','vi':'Sắp ra mắt','en':'Coming Soon'},
    'no data':    {'zh-Hans':'暂无数据','zh-Hant':'暫無資料','ja':'データなし','ko':'데이터 없음','fr':'Aucune donnée','de':'Keine Daten','es':'Sin datos','pt':'Sem dados','ru':'Нет данных','th':'ไม่มีข้อมูล','vi':'Không có dữ liệu','en':'No Data'},
    'empty':      {'zh-Hans':'空','zh-Hant':'空','ja':'空','ko':'비어 있음','fr':'Vide','de':'Leer','es':'Vacío','pt':'Vazio','ru':'Пусто','th':'ว่างเปล่า','vi':'Trống','en':'Empty'},
    'more':       {'zh-Hans':'更多','zh-Hant':'更多','ja':'もっと','ko':'더 보기','fr':'Plus','de':'Mehr','es':'Más','pt':'Mais','ru':'Ещё','th':'เพิ่มเติม','vi':'Thêm','en':'More'},

    // 电商通用
    'add to cart':  {'zh-Hans':'加入购物车','zh-Hant':'加入購物車','ja':'カートに入れる','ko':'장바구니에 담기','fr':'Ajouter au panier','de':'In den Warenkorb','es':'Añadir al carrito','pt':'Adicionar ao carrinho','ru':'В корзину','th':'เพิ่มลงตะกร้า','vi':'Thêm vào giỏ','en':'Add to Cart'},
    'buy now':      {'zh-Hans':'立即购买','zh-Hant':'立即購買','ja':'今すぐ買う','ko':'바로 구매','fr':'Acheter','de':'Jetzt kaufen','es':'Comprar ahora','pt':'Comprar agora','ru':'Купить','th':'ซื้อเลย','vi':'Mua ngay','en':'Buy Now'},
    'in stock':     {'zh-Hans':'有库存','zh-Hant':'有庫存','ja':'在庫あり','ko':'재고 있음','fr':'En stock','de':'Auf Lager','es':'En stock','pt':'Em estoque','ru':'В наличии','th':'มีสินค้า','vi':'Còn hàng','en':'In Stock'},
    'out of stock': {'zh-Hans':'缺货','zh-Hant':'缺貨','ja':'在庫切れ','ko':'품절','fr':'Rupture de stock','de':'Nicht auf Lager','es':'Agotado','pt':'Fora de estoque','ru':'Нет в наличии','th':'หมดสต็อก','vi':'Hết hàng','en':'Out of Stock'},
    'free shipping':{'zh-Hans':'免运费','zh-Hant':'免運費','ja':'送料無料','ko':'무료 배송','fr':'Livraison gratuite','de':'Kostenloser Versand','es':'Envío gratis','pt':'Frete grátis','ru':'Бесплатная доставка','th':'จัดส่งฟรี','vi':'Miễn phí vận chuyển','en':'Free Shipping'},
    'sold out':     {'zh-Hans':'售罄','zh-Hant':'售罄','ja':'売り切れ','ko':'품절','fr':'Épuisé','de':'Ausverkauft','es':'Agotado','pt':'Esgotado','ru':'Распродано','th':'ขายหมด','vi':'Hết hàng','en':'Sold Out'},
    'best seller':  {'zh-Hans':'热销','zh-Hant':'熱銷','ja':'ベストセラー','ko':'베스트셀러','fr':'Meilleure vente','de':'Bestseller','es':'Más vendido','pt':'Mais vendido','ru':'Хит продаж','th':'ขายดี','vi':'Bán chạy','en':'Best Seller'},
    'new arrival':  {'zh-Hans':'新品','zh-Hant':'新品','ja':'新着','ko':'신상품','fr':'Nouveauté','de':'Neu','es':'Novedad','pt':'Novidade','ru':'Новинка','th':'มาใหม่','vi':'Hàng mới','en':'New Arrival'},
    'on sale':      {'zh-Hans':'促销中','zh-Hant':'促銷中','ja':'セール中','ko':'세일 중','fr':'En promo','de':'Im Angebot','es':'En oferta','pt':'Em oferta','ru':'Распродажа','th':'ลดราคา','vi':'Đang giảm giá','en':'On Sale'},
    'discount':     {'zh-Hans':'折扣','zh-Hant':'折扣','ja':'割引','ko':'할인','fr':'Remise','de':'Rabatt','es':'Descuento','pt':'Desconto','ru':'Скидка','th':'ส่วนลด','vi':'Giảm giá','en':'Discount'},
    'price':        {'zh-Hans':'价格','zh-Hant':'價格','ja':'価格','ko':'가격','fr':'Prix','de':'Preis','es':'Precio','pt':'Preço','ru':'Цена','th':'ราคา','vi':'Giá','en':'Price'},
    'cart':         {'zh-Hans':'购物车','zh-Hant':'購物車','ja':'カート','ko':'장바구니','fr':'Panier','de':'Warenkorb','es':'Carrito','pt':'Carrinho','ru':'Корзина','th':'ตะกร้า','vi':'Giỏ hàng','en':'Cart'},
    'free delivery':{'zh-Hans':'免运费','zh-Hant':'免運費','ja':'送料無料','ko':'무료 배송','fr':'Livraison gratuite','de':'Kostenlose Lieferung','es':'Entrega gratis','pt':'Entrega grátis','ru':'Бесплатная доставка','th':'จัดส่งฟรี','vi':'Giao hàng miễn phí','en':'Free Delivery'},
    'best sellers': {'zh-Hans':'畅销榜','zh-Hant':'暢銷榜','ja':'ベストセラー','ko':'베스트셀러','fr':'Meilleures ventes','de':'Bestseller','es':'Más vendidos','pt':'Mais vendidos','ru':'Хиты продаж','th':'ขายดี','vi':'Bán chạy nhất','en':'Best Sellers'},
    'bestseller':   {'zh-Hans':'畅销品','zh-Hant':'暢銷品','ja':'ベストセラー','ko':'베스트셀러','fr':'Meilleure vente','de':'Bestseller','es':'Superventas','pt':'Mais vendido','ru':'Бестселлер','th':'ขายดี','vi':'Bán chạy','en':'Bestseller'},
    'customer reviews':{'zh-Hans':'用户评价','zh-Hant':'用戶評價','ja':'カスタマーレビュー','ko':'고객 리뷰','fr':'Avis clients','de':'Kundenrezensionen','es':'Opiniones de clientes','pt':'Avaliações de clientes','ru':'Отзывы покупателей','th':'รีวิวจากลูกค้า','vi':'Đánh giá của khách','en':'Customer Reviews'},
    'coupon':       {'zh-Hans':'优惠券','zh-Hant':'優惠券','ja':'クーポン','ko':'쿠폰','fr':'Coupon','de':'Gutschein','es':'Cupón','pt':'Cupom','ru':'Купон','th':'คูปอง','vi':'Phiếu giảm giá','en':'Coupon'},
    'featured':     {'zh-Hans':'精选','zh-Hant':'精選','ja':'注目','ko':'추천','fr':'En vedette','de':'Empfohlen','es':'Destacado','pt':'Destaque','ru':'Рекомендуемое','th':'แนะนำ','vi':'Nổi bật','en':'Featured'},
    'recommended':  {'zh-Hans':'推荐','zh-Hant':'推薦','ja':'おすすめ','ko':'추천','fr':'Recommandé','de':'Empfohlen','es':'Recomendado','pt':'Recomendado','ru':'Рекомендуется','th':'แนะนำ','vi':'Đề xuất','en':'Recommended'},
    'sponsored':    {'zh-Hans':'赞助','zh-Hant':'贊助','ja':'スポンサー','ko':'스폰서','fr':'Sponsorisé','de':'Gesponsert','es':'Patrocinado','pt':'Patrocinado','ru':'Реклама','th':'สนับสนุน','vi':'Được tài trợ','en':'Sponsored'},
    'top rated':    {'zh-Hans':'高评分','zh-Hant':'高評分','ja':'高評価','ko':'최고 평점','fr':'Les mieux notés','de':'Bestbewertet','es':'Mejor valorados','pt':'Mais bem avaliados','ru':'С высоким рейтингом','th':'คะแนนสูงสุด','vi':'Đánh giá cao nhất','en':'Top Rated'},
    'gift cards':   {'zh-Hans':'礼品卡','zh-Hant':'禮品卡','ja':'ギフトカード','ko':'기프트 카드','fr':'Cartes cadeaux','de':'Geschenkkarten','es':'Tarjetas de regalo','pt':'Cartões-presente','ru':'Подарочные карты','th':'บัตรของขวัญ','vi':'Thẻ quà tặng','en':'Gift Cards'},
    'gift ideas':   {'zh-Hans':'礼品推荐','zh-Hant':'禮品推薦','ja':'ギフトのアイデア','ko':'선물 아이디어','fr':'Idées cadeaux','de':'Geschenkideen','es':'Ideas de regalo','pt':'Ideias de presente','ru':'Идеи подарков','th':'ไอเดียของขวัญ','vi':'Ý tưởng quà tặng','en':'Gift Ideas'},
    'shop now':     {'zh-Hans':'立即购买','zh-Hant':'立即購買','ja':'今すぐ買う','ko':'지금 쇼핑','fr':'Acheter maintenant','de':'Jetzt einkaufen','es':'Comprar ahora','pt':'Comprar agora','ru':'Купить сейчас','th':'ช้อปเลย','vi':'Mua ngay','en':'Shop Now'},
    'buy again':    {'zh-Hans':'再次购买','zh-Hant':'再次購買','ja':'もう一度買う','ko':'다시 구매','fr':'Acheter à nouveau','de':'Erneut kaufen','es':'Volver a comprar','pt':'Comprar novamente','ru':'Купить снова','th':'ซื้ออีกครั้ง','vi':'Mua lại','en':'Buy Again'},
    'save more':    {'zh-Hans':'更多优惠','zh-Hant':'更多優惠','ja':'もっと節約','ko':'더 절약','fr':'Économisez plus','de':'Mehr sparen','es':'Ahorra más','pt':'Economize mais','ru':'Больше экономии','th':'ประหยัดมากขึ้น','vi':'Tiết kiệm hơn','en':'Save More'},

    // 页面导航工具
    'back to top':  {'zh-Hans':'返回顶部','zh-Hant':'返回頂部','ja':'トップへ戻る','ko':'맨 위로','fr':'Retour en haut','de':'Zurück nach oben','es':'Volver arriba','pt':'Voltar ao topo','ru':'Наверх','th':'กลับด้านบน','vi':'Về đầu trang','en':'Back to Top'},
    'back to results':{'zh-Hans':'返回结果','zh-Hant':'返回結果','ja':'結果に戻る','ko':'결과로 돌아가기','fr':'Retour aux résultats','de':'Zurück zu Ergebnissen','es':'Volver a resultados','pt':'Voltar aos resultados','ru':'Назад к результатам','th':'กลับไปผลลัพธ์','vi':'Quay lại kết quả','en':'Back to Results'},
    'filter by':    {'zh-Hans':'筛选方式','zh-Hant':'篩選方式','ja':'絞り込み','ko':'필터 기준','fr':'Filtrer par','de':'Filtern nach','es':'Filtrar por','pt':'Filtrar por','ru':'Фильтровать по','th':'กรองตาม','vi':'Lọc theo','en':'Filter By'},
    'sort by':      {'zh-Hans':'排序方式','zh-Hant':'排序方式','ja':'並び替え','ko':'정렬 기준','fr':'Trier par','de':'Sortieren nach','es':'Ordenar por','pt':'Ordenar por','ru':'Сортировать по','th':'เรียงตาม','vi':'Sắp xếp theo','en':'Sort By'},
    'unlimited':    {'zh-Hans':'无限','zh-Hant':'無限','ja':'無制限','ko':'무제한','fr':'Illimité','de':'Unbegrenzt','es':'Ilimitado','pt':'Ilimitado','ru':'Безлимитный','th':'ไม่จำกัด','vi':'Không giới hạn','en':'Unlimited'},
    'exclusive':    {'zh-Hans':'独家','zh-Hant':'獨家','ja':'限定','ko':'독점','fr':'Exclusif','de':'Exklusiv','es':'Exclusivo','pt':'Exclusivo','ru':'Эксклюзив','th':'พิเศษ','vi':'Độc quyền','en':'Exclusive'},

    // 商品详情
    'product details':    {'zh-Hans':'商品详情','zh-Hant':'商品詳情','ja':'商品詳細','ko':'제품 상세','fr':'Détails du produit','de':'Produktdetails','es':'Detalles del producto','pt':'Detalhes do produto','ru':'Детали товара','th':'รายละเอียดสินค้า','vi':'Chi tiết sản phẩm','en':'Product Details'},
    'product description':{'zh-Hans':'商品描述','zh-Hant':'商品描述','ja':'商品説明','ko':'제품 설명','fr':'Description du produit','de':'Produktbeschreibung','es':'Descripción del producto','pt':'Descrição do produto','ru':'Описание товара','th':'คำอธิบายสินค้า','vi':'Mô tả sản phẩm','en':'Product Description'},
    'about this item':    {'zh-Hans':'商品信息','zh-Hant':'商品資訊','ja':'この商品について','ko':'이 제품 정보','fr':'À propos de cet article','de':'Über diesen Artikel','es':'Acerca de este artículo','pt':'Sobre este item','ru':'Об этом товаре','th':'เกี่ยวกับสินค้า','vi':'Về sản phẩm này','en':'About This Item'},
    'technical details':  {'zh-Hans':'技术参数','zh-Hant':'技術參數','ja':'技術仕様','ko':'기술 사양','fr':'Caractéristiques techniques','de':'Technische Details','es':'Detalles técnicos','pt':'Detalhes técnicos','ru':'Технические характеристики','th':'รายละเอียดทางเทคนิค','vi':'Thông số kỹ thuật','en':'Technical Details'},

    // 页脚 / 公司
    'terms of service': {'zh-Hans':'服务条款','zh-Hant':'服務條款','ja':'利用規約','ko':'이용약관','fr':'Conditions d\'utilisation','de':'Nutzungsbedingungen','es':'Términos de servicio','pt':'Termos de serviço','ru':'Условия использования','th':'ข้อกำหนดการใช้','vi':'Điều khoản dịch vụ','en':'Terms of Service'},
    'privacy policy':   {'zh-Hans':'隐私政策','zh-Hant':'隱私權政策','ja':'プライバシーポリシー','ko':'개인정보처리방침','fr':'Politique de confidentialité','de':'Datenschutzerklärung','es':'Política de privacidad','pt':'Política de privacidade','ru':'Политика конфиденциальности','th':'นโยบายความเป็นส่วนตัว','vi':'Chính sách bảo mật','en':'Privacy Policy'},
    'contact us':       {'zh-Hans':'联系我们','zh-Hant':'聯絡我們','ja':'お問い合わせ','ko':'문의하기','fr':'Contactez-nous','de':'Kontakt','es':'Contacto','pt':'Contato','ru':'Свяжитесь с нами','th':'ติดต่อเรา','vi':'Liên hệ','en':'Contact Us'},
    'about us':         {'zh-Hans':'关于我们','zh-Hant':'關於我們','ja':'会社概要','ko':'회사 소개','fr':'À propos','de':'Über uns','es':'Sobre nosotros','pt':'Sobre nós','ru':'О нас','th':'เกี่ยวกับเรา','vi':'Về chúng tôi','en':'About Us'},
    'faq':              {'zh-Hans':'常见问题','zh-Hant':'常見問題','ja':'よくある質問','ko':'자주 묻는 질문','fr':'FAQ','de':'FAQ','es':'Preguntas frecuentes','pt':'FAQ','ru':'FAQ','th':'คำถามที่พบบ่อย','vi':'Câu hỏi thường gặp','en':'FAQ'},
    'help center':      {'zh-Hans':'帮助中心','zh-Hant':'幫助中心','ja':'ヘルプセンター','ko':'고객센터','fr':'Centre d\'aide','de':'Hilfe','es':'Centro de ayuda','pt':'Central de ajuda','ru':'Справка','th':'ศูนย์ช่วยเหลือ','vi':'Trung tâm trợ giúp','en':'Help Center'},
    'cookie policy':    {'zh-Hans':'Cookie 政策','zh-Hant':'Cookie 政策','ja':'クッキーポリシー','ko':'쿠키 정책','fr':'Politique de cookies','de':'Cookie-Richtlinie','es':'Política de cookies','pt':'Política de cookies','ru':'Политика cookie','th':'นโยบายคุกกี้','vi':'Chính sách cookie','en':'Cookie Policy'},
    'careers':          {'zh-Hans':'招聘','zh-Hant':'招聘','ja':'採用情報','ko':'채용','fr':'Carrières','de':'Karriere','es':'Empleo','pt':'Carreiras','ru':'Карьера','th':'ร่วมงานกับเรา','vi':'Tuyển dụng','en':'Careers'},
    'press':            {'zh-Hans':'新闻','zh-Hant':'新聞','ja':'ニュース','ko':'뉴스','fr':'Presse','de':'Presse','es':'Prensa','pt':'Imprensa','ru':'Пресса','th':'ข่าว','vi':'Báo chí','en':'Press'},

    // 时间
    'just now':   {'zh-Hans':'刚刚','zh-Hant':'剛剛','ja':'たった今','ko':'방금','fr':'À l\'instant','de':'Gerade jetzt','es':'Ahora mismo','pt':'Agora mesmo','ru':'Только что','th':'เมื่อสักครู่','vi':'Vừa xong','en':'Just Now'},
    'yesterday':  {'zh-Hans':'昨天','zh-Hant':'昨天','ja':'昨日','ko':'어제','fr':'Hier','de':'Gestern','es':'Ayer','pt':'Ontem','ru':'Вчера','th':'เมื่อวาน','vi':'Hôm qua','en':'Yesterday'},
    'today':      {'zh-Hans':'今天','zh-Hant':'今天','ja':'今日','ko':'오늘','fr':'Aujourd\'hui','de':'Heute','es':'Hoy','pt':'Hoje','ru':'Сегодня','th':'วันนี้','vi':'Hôm nay','en':'Today'},
    'tomorrow':   {'zh-Hans':'明天','zh-Hant':'明天','ja':'明日','ko':'내일','fr':'Demain','de':'Morgen','es':'Mañana','pt':'Amanhã','ru':'Завтра','th':'พรุ่งนี้','vi':'Ngày mai','en':'Tomorrow'},

    // 社交
    'follow':     {'zh-Hans':'关注','zh-Hant':'追蹤','ja':'フォロー','ko':'팔로우','fr':'Suivre','de':'Folgen','es':'Seguir','pt':'Seguir','ru':'Подписаться','th':'ติดตาม','vi':'Theo dõi','en':'Follow'},
    'subscribe':  {'zh-Hans':'订阅','zh-Hant':'訂閱','ja':'登録','ko':'구독','fr':'S\'abonner','de':'Abonnieren','es':'Suscribirse','pt':'Inscrever-se','ru':'Подписаться','th':'สมัครรับข่าวสาร','vi':'Đăng ký','en':'Subscribe'},
    'like':       {'zh-Hans':'赞','zh-Hant':'讚','ja':'いいね','ko':'좋아요','fr':'J\'aime','de':'Gefällt mir','es':'Me gusta','pt':'Curtir','ru':'Нравится','th':'ถูกใจ','vi':'Thích','en':'Like'},
    'comment':    {'zh-Hans':'评论','zh-Hant':'留言','ja':'コメント','ko':'댓글','fr':'Commentaire','de':'Kommentar','es':'Comentario','pt':'Comentário','ru':'Комментарий','th':'ความคิดเห็น','vi':'Bình luận','en':'Comment'},
    'share':      {'zh-Hans':'分享','zh-Hant':'分享','ja':'共有','ko':'공유','fr':'Partager','de':'Teilen','es':'Compartir','pt':'Compartilhar','ru':'Поделиться','th':'แชร์','vi':'Chia sẻ','en':'Share'},
    'follow us':  {'zh-Hans':'关注我们','zh-Hant':'追蹤我們','ja':'フォローする','ko':'팔로우하기','fr':'Suivez-nous','de':'Folgen Sie uns','es':'Síguenos','pt':'Siga-nos','ru':'Подписывайтесь','th':'ติดตามเรา','vi':'Theo dõi chúng tôi','en':'Follow Us'},
  };

  // ── 正则模板（含数字变量的跨语言通用句式）───────────────────────────
  const patternRules = [
    // 百分比折扣
    [/^(\d+)\s*%\s*off$/i,
      function (_, p, lang) { var m = {'zh-Hans':'优惠'+p+'%','zh-Hant':'優惠'+p+'%','ja':p+'%オフ','ko':p+'% 할인','fr':p+'% de réduction','de':p+'% Rabatt','es':p+'% de descuento','pt':p+'% de desconto','ru':'Скидка '+p+'%','th':'ลด '+p+'%','vi':'Giảm '+p+'%','en':p+'% Off'}; return m[lang] || (p+'% Off'); }],
    // 数字 + 已售
    [/^(\d[\d,]*)\+?\s*sold$/i,
      function (_, n, lang) { var m = {'zh-Hans':'已售'+n+'件','zh-Hant':'已售'+n+'件','ja':n+'個販売済','ko':n+'개 판매','fr':n+' vendus','de':n+' verkauft','es':n+' vendidos','pt':n+' vendidos','ru':'Продано: '+n,'th':'ขายแล้ว '+n,'vi':'Đã bán '+n,'en':n+' Sold'}; return m[lang] || (n+' Sold'); }],
    // 数字 + 评价
    [/^(\d[\d,]*)\s*reviews?$/i,
      function (_, n, lang) { var m = {'zh-Hans':n+'条评价','zh-Hant':n+'則評價','ja':n+'件のレビュー','ko':'리뷰 '+n+'개','fr':n+' avis','de':n+' Bewertungen','es':n+' reseñas','pt':n+' avaliações','ru':n+' отзывов','th':n+' รีวิว','vi':n+' đánh giá','en':n+' Reviews'}; return m[lang] || (n+' Reviews'); }],
    // 数字 + 评分
    [/^(\d[\d,]*)\s*ratings?$/i,
      function (_, n, lang) { var m = {'zh-Hans':n+'个评分','zh-Hant':n+'個評分','ja':n+'件の評価','ko':'평점 '+n+'개','fr':n+' notes','de':n+' Bewertungen','es':n+' valoraciones','pt':n+' avaliações','ru':n+' оценок','th':n+' คะแนน','vi':n+' đánh giá','en':n+' Ratings'}; return m[lang] || (n+' Ratings'); }],
    // up to X% off
    [/^up\s+to\s+(\d+)\s*%\s*off$/i,
      function (_, p, lang) { var m = {'zh-Hans':'最高优惠'+p+'%','zh-Hant':'最高優惠'+p+'%','ja':'最大'+p+'%オフ','ko':'최대 '+p+'% 할인','fr':'Jusqu\'à '+p+'% de réduction','de':'Bis zu '+p+'% Rabatt','es':'Hasta '+p+'% de descuento','pt':'Até '+p+'% de desconto','ru':'Скидка до '+p+'%','th':'ลดสูงสุด '+p+'%','vi':'Giảm đến '+p+'%','en':'Up to '+p+'% Off'}; return m[lang] || ('Up to '+p+'% Off'); }],
  ];

  // ── 词级替换（postProcess，按目标语言执行，保留兼容）───────────────
  // 当前词典已直接返回目标语言译文，postProcess 不再需要做语言转换。
  // 保留为空操作以兼容 page-translate.js 调用。

  // ── 对外接口 ──────────────────────────────────────────────────────
  function localTranslate(text, targetLang) {
    var t = text.trim();
    if (!t) return null;

    // 精确匹配（不区分大小写）
    var lower = t.toLowerCase();
    var entry = uiDict[lower];
    if (entry) {
      if (entry[targetLang]) return entry[targetLang];
      if (targetLang === 'zh' && entry['zh-Hans']) return entry['zh-Hans'];
      if (targetLang === 'zh-Hant' && entry['zh-Hans']) return entry['zh-Hans'];
    }

    // 正则模式
    for (var i = 0; i < patternRules.length; i++) {
      var re = patternRules[i][0];
      var fn = patternRules[i][1];
      var m = t.match(re);
      if (m) return fn.apply(null, m.concat([targetLang]));
    }

    return null;
  }

  function postProcess(translated) {
    // 词典已直接返回目标语言译文，无需词级替换
    return translated;
  }

  function mergeSceneDict(items) {
    // 保留接口兼容，动态注入场景词典（如特定电商站）
    if (!items) return 0;
    var count = 0;
    var insert = function (src, dstMap) {
      if (!src || !dstMap) return;
      var k = String(src).toLowerCase();
      if (!uiDict[k]) { uiDict[k] = dstMap; count++; }
    };
    if (Array.isArray(items)) {
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it && typeof it === 'object' && !Array.isArray(it)) insert(it.src || it.k, it.dst || it.v || it);
      }
    }
    return count;
  }

  window.__ai_dict = {
    localTranslate: localTranslate,
    postProcess: postProcess,
    mergeSceneDict: mergeSceneDict,
  };
})();
