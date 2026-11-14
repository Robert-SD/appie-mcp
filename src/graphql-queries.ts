/**
 * Shared GraphQL field selections and operation documents for api.ah.nl/graphql.
 */

const PRODUCT_MEDIA_AND_AVAILABILITY_FIELDS = `
  id
  title
  brand
  category
  icons
  salesUnitSize
  availability {
    online { status }
    isOrderable
  }
  imagePack {
    large { url width height }
    medium { url width height }
    small { url width height }
  }
`;

const PRODUCT_DETAIL_CARD_FIELDS = `
  ${PRODUCT_MEDIA_AND_AVAILABILITY_FIELDS}
  summary
  priceV2 {
    now { amount }
    was { amount }
    unitInfo { description price { amount formattedV2 } }
    discount { description promotionType }
    promotionLabel { tiers { mechanism description } }
  }
`;

const BASKET_PRODUCT_FIELDS = `
  position
  originCode
  quantity
  product {
    id
    title
    brand
    salesUnitSize
    category
    priceV2 {
      now { amount }
      was { amount }
    }
  }
`;

export const GRAPHQL_QUERIES = {
  FetchMember: `query FetchMember {
    member {
      id
      emailAddress
      name {
        first
        last
      }
      loyaltyCards {
        loyaltyCards {
          cardNumber
          type
          barcodeNumber
        }
      }
    }
  }`,

  FetchProductDetails: `query FetchProductDetails($productId: Int!) {
    product(id: $productId) {
      ${PRODUCT_DETAIL_CARD_FIELDS}
      highlights
      additionalInformation
    }
  }`,

  FetchProductAlternatives: `query FetchProductAlternatives($productId: Int!, $size: PageSize!) {
    productAlternatives(id: $productId, size: $size) {
      products {
        ${PRODUCT_DETAIL_CARD_FIELDS}
      }
    }
  }`,

  FetchCategories: `query FetchCategories {
    productTopLevelTaxonomies {
      id
      name
      slug
      active
      totalProductCount
      topLevelImage
    }
  }`,

  FetchSubCategories: `query FetchSubCategories($id: Int!) {
    productTaxonomyById(id: $id) {
      id
      name
      slug
      active
      totalProductCount
      children
    }
  }`,

  FetchBonusPromotionWithProducts: `query FetchBonusPromotionWithProducts(
    $id: String
    $periodStart: String
    $periodEnd: String
    $filterUnavailableProducts: Boolean
    $forcePromotionVisibility: Boolean = true
    $showAllPromotionSegments: Boolean = true
  ) {
    bonusPromotions(
      input: {
        id: $id
        periodStart: $periodStart
        periodEnd: $periodEnd
        filterUnavailableProducts: $filterUnavailableProducts
        forcePromotionVisibility: $forcePromotionVisibility
        showAllPromotionSegments: $showAllPromotionSegments
      }
    ) {
      id
      title
      productCount
      products {
        ${PRODUCT_MEDIA_AND_AVAILABILITY_FIELDS}
        priceV2(
          periodStart: $periodStart
          periodEnd: $periodEnd
          filterUnavailableProducts: $filterUnavailableProducts
          forcePromotionVisibility: true
        ) {
          now { amount }
          was { amount }
          promotionLabel {
            tiers {
              mechanism
              description
            }
          }
        }
      }
    }
  }`,

  BargainItems: `query BargainItems($storeId: String!) {
    bargainItems(storeId: $storeId) {
      product {
        id
        title
        brand
        salesUnitSize
      }
      categoryTitle
      markdown {
        markdownType
        markdownExpirationDate
        markdownPercentage
      }
      stock
      bargainPrice {
        priceWas
        priceNow
      }
    }
  }`,

  FetchFavoriteLists: `query FetchFavoriteLists($ids: [String!]!, $productIds: [Int!]!) {
    favoriteListV2(ids: $ids, productIds: $productIds) {
      id
      description
      totalSize
      imageUrl
      items {
        id
        productId
        quantity
      }
    }
  }`,

  AddProductsToFavoriteList: `mutation AddProductsToFavoriteList($favoriteListId: String!, $products: [FavoriteListProductMutation!]!) {
    favoriteListProductsAddV2(id: $favoriteListId, products: $products) {
      status
      errorMessage
    }
  }`,

  DeleteProductsFromFavoriteList: `mutation DeleteProductsFromFavoriteList($favoriteListId: String!, $itemIds: [String!]!) {
    favoriteListProductsDeleteV2(id: $favoriteListId, itemIds: $itemIds) {
      status
      errorMessage
    }
  }`,

  FetchPosReceiptsPage: `query FetchPosReceiptsPage($pagination: OffsetLimitPagination!) {
    posReceiptsPage(pagination: $pagination) {
      pagination {
        totalElements
      }
      posReceipts {
        id
        dateTime
        storeAddress {
          street
          houseNumber
          postalCode
          city
        }
        totalAmount {
          amount
        }
      }
    }
  }`,

  FetchPosReceiptsDetails: `query FetchPosReceiptsDetails($id: String!) {
    posReceiptDetails(id: $id) {
      total {
        amount
      }
      subtotalProducts {
        amount {
          amount
        }
      }
      subtotalDiscount {
        amount
      }
      transaction {
        dateTime
      }
      products {
        name
        quantity
        amount {
          amount
        }
        price {
          amount
        }
      }
    }
  }`,

  FetchRecipes: `query FetchRecipes(
    $searchText: String
    $start: Int
    $size: PageSize
    $sortBy: RecipeSearchSortOption
    $filters: [RecipeSearchQueryFilter!]
    $priorityRecipeIds: [Int!]
    $boostFavoriteRecipeIds: [Int!]
    $recipeIds: [Int!]!
    $ingredients: [String!]
  ) {
    recipeSearchV2(
      searchText: $searchText
      start: $start
      size: $size
      sortBy: $sortBy
      filters: $filters
      priorityRecipeIds: $priorityRecipeIds
      boostFavoriteRecipeIds: $boostFavoriteRecipeIds
      recipeIds: $recipeIds
      ingredients: $ingredients
    ) {
      page {
        total
        hasNextPage
      }
      result {
        id
        title
        slug
        time {
          cook
          oven
          wait
        }
        serving {
          number
        }
        images(renditions: [S, M, D445X297, D890X594]) {
          width
          height
          url
        }
      }
    }
  }`,

  FetchRecipeDetails: `query FetchRecipeDetails($id: Int!) {
    recipe(id: $id) {
      id
      title
      href
      cookTime
      ovenTime
      waitTime
      servings {
        number
      }
      images {
        width
        height
        url
      }
      ingredients {
        id
        name {
          singular
          plural
        }
        quantity
        quantityUnit {
          singular
          plural
        }
        text
      }
      preparation {
        steps
      }
    }
  }`,

  StoresSearch: `query StoresSearch($filter: StoresFilterInput, $limit: Int) {
    storesSearch(filter: $filter, limit: $limit) {
      pageInfo {
        total
        hasNextPage
      }
      result {
        id
        name
        phone
        storeType
        address {
          street
          houseNumber
          houseNumberExtra
          postalCode
          city
        }
        openingDays {
          dayName
          openingHour {
            openFrom
            openUntil
          }
        }
        services {
          code
          description
        }
      }
    }
  }`,

  FetchMyListBasket: `query FetchMyListBasket {
    basket(input: null) {
      canChangeDelivery
      itemsInOrder {
        isClosed
        allocatedQuantity
        ${BASKET_PRODUCT_FIELDS}
      }
      notes {
        description
        isStrikethrough
        originCode
        position
        quantity
        searchTerm
      }
      products {
        isStrikethrough
        ${BASKET_PRODUCT_FIELDS}
      }
      summary {
        isCancellable
        quantity
        shoppingType
        lastUserChangeDateTime
        price {
          discount { amount }
          totalPrice { amount }
          priceAfterDiscount { amount }
          priceBeforeDiscount { amount }
        }
      }
    }
    order {
      delivery {
        address {
          street
          houseNumber
          houseNumberExtra
          zipCode
          city
          countryCode
        }
        date
        endTime
        startTime
        status
        id
        shiftCode
        pickupLocationId
      }
    }
  }`,
} as const;
