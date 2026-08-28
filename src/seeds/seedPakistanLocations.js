// src/seeds/seedPakistanLocations.js
// Seeds Pakistan with its provinces and major cities into the Country
// (formerly "County") collection. Idempotent — re-running adds only
// missing entries; existing rows are left untouched.
//
// Run: `node src/seeds/seedPakistanLocations.js`
//      or `npm run seed:pakistan-locations`
const mongoose = require('mongoose');
require('dotenv').config();

const Country = require('../models/country');

const PAKISTAN = {
  name: 'Pakistan',
  code: 'PK',
  isActive: true,
  provinces: [
    {
      name: 'Punjab',
      cities: [
        'Lahore', 'Faisalabad', 'Rawalpindi', 'Multan', 'Gujranwala', 'Sialkot',
        'Bahawalpur', 'Sargodha', 'Sahiwal', 'Okara', 'Sheikhupura', 'Gujrat',
        'Jhelum', 'Kasur', 'Wah Cantt', 'Dera Ghazi Khan', 'Rahim Yar Khan',
        'Mianwali', 'Chiniot', 'Toba Tek Singh', 'Jhang', 'Vehari', 'Pakpattan',
        'Khanewal', 'Hafizabad', 'Mandi Bahauddin', 'Narowal', 'Attock', 'Chakwal',
        'Bhakkar', 'Layyah', 'Lodhran', 'Muzaffargarh', 'Rajanpur', 'Khushab',
        'Nankana Sahib',
      ],
    },
    {
      name: 'Sindh',
      cities: [
        'Karachi', 'Hyderabad', 'Sukkur', 'Larkana', 'Nawabshah', 'Mirpur Khas',
        'Jacobabad', 'Shikarpur', 'Khairpur', 'Dadu', 'Thatta', 'Badin',
        'Tando Allahyar', 'Tando Adam', 'Tando Muhammad Khan', 'Umerkot',
        'Sanghar', 'Ghotki', 'Kashmore', 'Matiari', 'Jamshoro', 'Sujawal',
      ],
    },
    {
      name: 'Khyber Pakhtunkhwa',
      cities: [
        'Peshawar', 'Mardan', 'Mingora', 'Abbottabad', 'Kohat', 'Swabi', 'Bannu',
        'Charsadda', 'Nowshera', 'Mansehra', 'Dera Ismail Khan', 'Haripur',
        'Chitral', 'Hangu', 'Karak', 'Lakki Marwat', 'Tank', 'Battagram',
        'Buner', 'Lower Dir', 'Upper Dir', 'Malakand', 'Shangla', 'Kohistan',
        'Tor Ghar', 'Torghar', 'Kurram', 'Khyber', 'Orakzai',
      ],
    },
    {
      name: 'Balochistan',
      cities: [
        'Quetta', 'Gwadar', 'Turbat', 'Khuzdar', 'Chaman', 'Hub', 'Sibi',
        'Loralai', 'Zhob', 'Mastung', 'Kalat', 'Lasbela', 'Dera Bugti',
        'Kohlu', 'Kharan', 'Nushki', 'Pishin', 'Awaran', 'Panjgur',
        'Jhal Magsi', 'Naseerabad', 'Jaffarabad', 'Killa Abdullah',
        'Killa Saifullah', 'Sherani', 'Harnai', 'Ziarat', 'Musakhel', 'Washuk',
      ],
    },
    {
      name: 'Islamabad Capital Territory',
      cities: ['Islamabad'],
    },
    {
      name: 'Azad Jammu & Kashmir',
      cities: [
        'Muzaffarabad', 'Mirpur', 'Rawalakot', 'Kotli', 'Bagh', 'Bhimber',
        'Hattian Bala', 'Haveli', 'Neelum', 'Sudhanoti', 'Poonch',
      ],
    },
    {
      name: 'Gilgit-Baltistan',
      cities: [
        'Gilgit', 'Skardu', 'Hunza', 'Chilas', 'Astore', 'Ghizer', 'Diamer',
        'Ghanche', 'Shigar', 'Kharmang', 'Nagar',
      ],
    },
  ],
};

async function seedPakistanLocations() {
  const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/InkedWear';
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB\n');

  let country = await Country.findOne({
    name: { $regex: new RegExp(`^${PAKISTAN.name}$`, 'i') },
  });

  let created = 0;
  let provincesAdded = 0;
  let citiesAdded = 0;
  let provincesExisting = 0;
  let citiesExisting = 0;

  if (!country) {
    country = new Country({
      name: PAKISTAN.name,
      code: PAKISTAN.code,
      isActive: PAKISTAN.isActive,
      cities: [], // provinces array (DB field name retained)
    });
    created = 1;
    console.log(`Created country: ${PAKISTAN.name} (${PAKISTAN.code})`);
  } else {
    console.log(`Country already exists: ${country.name}`);
  }

  for (const province of PAKISTAN.provinces) {
    let provinceDoc = country.cities.find(
      (p) => p.name.toLowerCase() === province.name.toLowerCase()
    );

    if (!provinceDoc) {
      country.cities.push({ name: province.name, isActive: true, cities: [] });
      provinceDoc = country.cities[country.cities.length - 1];
      provincesAdded++;
      console.log(`  + Added province: ${province.name}`);
    } else {
      provincesExisting++;
      console.log(`  · Province already exists: ${province.name}`);
    }

    if (!provinceDoc.cities) provinceDoc.cities = [];

    for (const cityName of province.cities) {
      const exists = provinceDoc.cities.some(
        (c) => c.name.toLowerCase() === cityName.toLowerCase()
      );
      if (!exists) {
        provinceDoc.cities.push({ name: cityName, isActive: true });
        citiesAdded++;
      } else {
        citiesExisting++;
      }
    }
    console.log(
      `    cities: ${province.cities.length} total, ` +
      `${provinceDoc.cities.length} now stored`
    );
  }

  await country.save();

  console.log('\n--- Summary ---');
  console.log(`Country created:   ${created}`);
  console.log(`Provinces added:   ${provincesAdded}`);
  console.log(`Provinces kept:    ${provincesExisting}`);
  console.log(`Cities added:      ${citiesAdded}`);
  console.log(`Cities kept:       ${citiesExisting}`);
  console.log(`Total provinces:   ${country.cities.length}`);
  console.log(
    `Total cities:      ${country.cities.reduce(
      (sum, p) => sum + (p.cities ? p.cities.length : 0),
      0
    )}`
  );
}

seedPakistanLocations()
  .then(() => {
    console.log('\nSeeding complete.');
    return mongoose.disconnect();
  })
  .catch((err) => {
    console.error('\nSeeder failed:', err);
    return mongoose.disconnect().finally(() => process.exit(1));
  });
