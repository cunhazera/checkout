/**
 * Screen copy, in the store's language.
 *
 * A store declares its locale (and its currency) in the database, so a São
 * Paulo totem already formats money as "R$ 12,90". Until now it said "Your
 * basket" above it. Money and words have to come from the same place.
 *
 * Deliberately small: a dictionary and one interpolation rule, no library. Adding
 * a language is adding a block below. If this ever grows past a few languages,
 * or needs plural rules beyond one/other, swap it for a real i18n library —
 * the call sites will not have to change.
 */

type Lang = 'en' | 'pt';

let lang: Lang = 'en';

/** Picks the language from a BCP 47 locale, falling back to English. */
export function configureLanguage(locale: string): void {
  lang = locale.toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

export const currentLanguage = (): Lang => lang;

const en = {
  selfCheckout: 'Self-checkout',
  welcomeLede: 'Pick your items on screen, then pay by card or phone. No account needed.',
  touchToStart: 'Touch to start',
  payCardTap: 'Card tap',
  payWallets: 'Apple & Google Pay',
  payQr: 'QR payment',

  addYourItems: 'Add your items',
  emptyBasket: 'Empty basket',
  shopHint: 'Tap a product, confirm the quantity, then pay.',
  itemAdded: '{name} added',
  basketEmptied: 'Basket emptied.',
  itemSoldOutStatus: '{name} sold out',
  badgeAdd: 'Add',
  badgeSoldOut: 'Sold out',
  badgeInBasket: '{n} in basket',
  badgeAllInBasket: 'All in basket',
  oneItem: '1 item',
  nItems: '{n} items',
  reviewAndPay: 'Review & pay',

  howMany: 'How many?',
  cancel: 'Cancel',
  addToBasket: 'Add {total} to basket',
  lastOneInStock: 'This is the last one in stock.',
  onlyNLeft: 'Only {n} left in stock.',

  yourBasket: 'Your basket',
  basketHint: 'Change quantities before you pay.',
  basketEmpty: 'Your basket is empty. Go back and tap an item.',
  eachAndSize: '{price} each · {size}',
  each: '{price} each',
  subtotal: 'Subtotal',
  tax: 'Tax ({percent}%)',
  total: 'Total',
  addMore: 'Add more',
  pay: 'Pay {total}',
  reserving: 'Reserving…',

  amountDue: 'Amount due',
  chooseHowToPay: 'Choose how to pay',
  methodCard: 'Card',
  methodCardNote: 'Credit or debit',
  methodWallet: 'Apple / Google Pay',
  methodWalletNote: 'Phone wallet',
  methodQr: 'QR payment',
  methodQrNote: 'Scan with your bank app',
  selectAMethod: 'Select a payment method',
  confirmingPayment: 'Confirming your payment…',
  doNotWalkAway: 'Follow the instructions on the card reader. Please do not walk away.',

  paidEnjoy: 'Paid. Enjoy.',
  paidBody: 'Payment went through. Take your items with you.',
  declined: 'Payment declined',
  declinedBody:
    'The payment was not accepted. Nothing was charged. Try again or choose another payment method.',
  contactStaff: 'Please contact staff',
  unknownBody:
    'We could not confirm your payment. Do not try again — staff will check whether it went through.',
  reference: 'Reference {ref}',
  receiptTitle: 'Receipt on your phone',
  receiptNote: 'Scan this code to open it. Nothing is printed.',
  orderLine: 'Order {code} · {total}',
  tryAgain: 'Try payment again',
  done: 'Done',
  cancelOrder: 'Cancel order',
  returningSoon: 'Returning to the start screen in a few seconds.',

  stillThere: 'Are you still there?',
  stillThereBody: 'Your basket will be cleared shortly so the next person can use the totem.',
  imStillHere: "I'm still here",

  soldOutRemoved: '{name} just sold out and was removed from your order.',
  sessionTimedOut: 'Your session timed out and the order was released.',
  couldNotStartOrder: 'Could not start your order. Please try again.',
  couldNotPay: 'Payment could not be completed.',
  nothingWasCharged: 'The payment was not accepted. Nothing was charged.',
  cannotStart: 'Cannot start a session. Please ask staff for help.',
  menuUnavailable: 'Menu unavailable',

  outOfService: 'Out of service',
  outOfServiceBody:
    'This totem cannot take orders right now. Please ask a member of staff, or use another totem.',
  outOfServiceUnprovisioned:
    'This totem has not been set up yet. Please ask a member of staff.',
} as const;

type Key = keyof typeof en;

const pt: Record<Key, string> = {
  selfCheckout: 'Autoatendimento',
  welcomeLede: 'Escolha seus itens na tela e pague com cartão ou celular. Sem cadastro.',
  touchToStart: 'Toque para começar',
  payCardTap: 'Aproximação',
  payWallets: 'Apple e Google Pay',
  payQr: 'Pagamento por QR',

  addYourItems: 'Adicione seus itens',
  emptyBasket: 'Esvaziar cesta',
  shopHint: 'Toque em um produto, confirme a quantidade e pague.',
  itemAdded: '{name} adicionado',
  basketEmptied: 'Cesta esvaziada.',
  itemSoldOutStatus: '{name} esgotado',
  badgeAdd: 'Adicionar',
  badgeSoldOut: 'Esgotado',
  badgeInBasket: '{n} na cesta',
  badgeAllInBasket: 'Tudo na cesta',
  oneItem: '1 item',
  nItems: '{n} itens',
  reviewAndPay: 'Revisar e pagar',

  howMany: 'Quantos?',
  cancel: 'Cancelar',
  addToBasket: 'Adicionar {total} à cesta',
  lastOneInStock: 'Este é o último em estoque.',
  onlyNLeft: 'Restam apenas {n} em estoque.',

  yourBasket: 'Sua cesta',
  basketHint: 'Altere as quantidades antes de pagar.',
  basketEmpty: 'Sua cesta está vazia. Volte e toque em um item.',
  eachAndSize: '{price} cada · {size}',
  each: '{price} cada',
  subtotal: 'Subtotal',
  tax: 'Impostos ({percent}%)',
  total: 'Total',
  addMore: 'Adicionar mais',
  pay: 'Pagar {total}',
  reserving: 'Reservando…',

  amountDue: 'Valor a pagar',
  chooseHowToPay: 'Escolha como pagar',
  methodCard: 'Cartão',
  methodCardNote: 'Crédito ou débito',
  methodWallet: 'Apple / Google Pay',
  methodWalletNote: 'Carteira no celular',
  methodQr: 'Pagamento por QR',
  methodQrNote: 'Escaneie no app do seu banco',
  selectAMethod: 'Selecione uma forma de pagamento',
  confirmingPayment: 'Confirmando seu pagamento…',
  doNotWalkAway: 'Siga as instruções na maquininha. Não se afaste.',

  paidEnjoy: 'Pago. Aproveite.',
  paidBody: 'O pagamento foi aprovado. Pode levar seus itens.',
  declined: 'Pagamento recusado',
  declinedBody:
    'O pagamento não foi aceito. Nada foi cobrado. Tente de novo ou escolha outra forma de pagamento.',
  contactStaff: 'Procure um atendente',
  unknownBody:
    'Não conseguimos confirmar seu pagamento. Não tente de novo — um atendente vai verificar se ele foi aprovado.',
  reference: 'Referência {ref}',
  receiptTitle: 'Recibo no seu celular',
  receiptNote: 'Escaneie este código para abrir. Nada é impresso.',
  orderLine: 'Pedido {code} · {total}',
  tryAgain: 'Tentar pagar de novo',
  done: 'Concluir',
  cancelOrder: 'Cancelar pedido',
  returningSoon: 'Voltando à tela inicial em alguns segundos.',

  stillThere: 'Você ainda está aí?',
  stillThereBody: 'Sua cesta será esvaziada em instantes para o próximo cliente.',
  imStillHere: 'Ainda estou aqui',

  soldOutRemoved: '{name} esgotou e foi removido do seu pedido.',
  sessionTimedOut: 'Sua sessão expirou e o pedido foi liberado.',
  couldNotStartOrder: 'Não foi possível iniciar seu pedido. Tente novamente.',
  couldNotPay: 'Não foi possível concluir o pagamento.',
  nothingWasCharged: 'O pagamento não foi aceito. Nada foi cobrado.',
  cannotStart: 'Não foi possível iniciar. Peça ajuda a um atendente.',
  menuUnavailable: 'Cardápio indisponível',

  outOfService: 'Fora de serviço',
  outOfServiceBody:
    'Este totem não consegue registrar pedidos agora. Procure um atendente ou use outro totem.',
  outOfServiceUnprovisioned: 'Este totem ainda não foi configurado. Procure um atendente.',
};

const dictionaries: Record<Lang, Record<Key, string>> = { en, pt };

/** Looks up a phrase and fills in {placeholders}. */
export function t(key: Key, params?: Record<string, string | number>): string {
  const phrase = dictionaries[lang][key] ?? en[key];
  if (!params) return phrase;
  return phrase.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/** "1 item" / "N items", in the store's language. */
export const itemCountLabel = (n: number): string =>
  n === 1 ? t('oneItem') : t('nItems', { n });
