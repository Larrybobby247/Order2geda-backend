export const STATES = ['Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT (Abuja)', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara'];
export const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function canonState(s) {
  const k = key(String(s || '').replace(/\sstate$/i, '')); if (!k) return '';
  if (['fct', 'abuja', 'federalcapitalterritory', 'fctabuja'].includes(k)) return 'FCT (Abuja)';
  return STATES.find((x) => key(x) === k) || '';
}
// Maps an OpenStreetMap/Nominatim reverse-geocode result to a Nigerian state + candidate areas (the user confirms the final choice).
export function mapNominatim(j) {
  const a = j?.address || {}; const state = canonState(a.state || a.region || '');
  const c = [a.neighbourhood, a.suburb, a.city_district, a.quarter, a.town, a.village, a.city, a.county, a.state_district].filter(Boolean).map((x) => x.replace(/\sLocal Government Area$/i, '').trim());
  const candidates = [...new Set(c)].slice(0, 6); return { state, area: candidates[0] || '', candidates, label: j?.display_name || '' };
}
