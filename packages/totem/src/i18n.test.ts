import { describe, it, expect, afterEach } from 'vitest';
import { configureLanguage, currentLanguage, itemCountLabel, t } from './i18n';

afterEach(() => configureLanguage('en-US'));

describe('store language', () => {
  it('follows the store locale', () => {
    configureLanguage('pt-BR');
    expect(currentLanguage()).toBe('pt');
    expect(t('yourBasket')).toBe('Sua cesta');
  });

  it('falls back to English for a locale we do not carry', () => {
    configureLanguage('fr-FR');
    expect(currentLanguage()).toBe('en');
    expect(t('yourBasket')).toBe('Your basket');
  });

  it('fills in placeholders', () => {
    expect(t('addToBasket', { total: '$4.80' })).toBe('Add $4.80 to basket');
    configureLanguage('pt-BR');
    expect(t('addToBasket', { total: 'R$ 12,90' })).toBe('Adicionar R$ 12,90 à cesta');
  });

  it('counts items in each language', () => {
    expect(itemCountLabel(1)).toBe('1 item');
    expect(itemCountLabel(3)).toBe('3 items');
    configureLanguage('pt-BR');
    expect(itemCountLabel(3)).toBe('3 itens');
  });

  it('leaves an unknown placeholder visible rather than printing undefined', () => {
    expect(t('reference', {})).toBe('Reference {ref}');
  });

  it('translates the result screen, where the wording matters most', () => {
    // Completeness is enforced by the type (Record<Key, string>), so these
    // check the phrases a customer reads on a bad day.
    configureLanguage('pt-BR');
    expect(t('paidEnjoy')).toBe('Pago. Aproveite.');
    expect(t('declined')).toBe('Pagamento recusado');
    expect(t('contactStaff')).toBe('Procure um atendente');
    expect(t('unknownBody')).toMatch(/não tente de novo/i);
  });
});
