/// <reference path="hitbtc.ts" />
/// <reference path="okcoin.ts" />
/// <reference path="arbagent.ts" />
/// <reference path="../common/models.ts" />
/// <reference path="../common/messaging.ts" />
/// <reference path="config.ts" />

import Utils = require("./utils");
import Config = require("./config");
import HitBtc = require("./hitbtc");
import OkCoin = require("./okcoin");
import NullGw = require("./nullgw");
import Broker = require("./broker");
import Agent = require("./arbagent");
import MarketTrades = require("./markettrades");
import Messaging = require("../common/messaging");
import Models = require("../common/models");
import Interfaces = require("./interfaces");
import Quoter = require("./quoter");
import Safety = require("./safety");
import path = require("path");
import express = require('express');
import compression = require("compression");
import Persister = require("./persister");

var mainLog = Utils.log("tribeca:main");
var messagingLog = Utils.log("tribeca:messaging");

var app = express();
var http = (<any>require('http')).Server(app);
var io = require('socket.io')(http);

app.use(<any>compression());
app.use(express.static(path.join(__dirname, "admin")));
http.listen(3000, () => mainLog('Listening to admins on *:3000...'));

var env = process.env.TRIBECA_MODE;
var config = new Config.ConfigProvider(env);

var getExch = () : Interfaces.CombinedGateway => {
    var ex = process.env.EXCHANGE.toLowerCase();
    switch (ex) {
        case "hitbtc": return <Interfaces.CombinedGateway>(new HitBtc.HitBtc(config));
        case "okcoin": return <Interfaces.CombinedGateway>(new OkCoin.OkCoin(config));
        case "null": return <Interfaces.CombinedGateway>(new NullGw.NullGateway());
        default: throw new Error("unknown configuration env variable EXCHANGE " + ex);
    }
};

var gateway = getExch();

var pair = new Models.CurrencyPair(Models.Currency.BTC, Models.Currency.USD);
var advert = new Models.ProductAdvertisement(gateway.base.exchange(), pair);
new Messaging.Publisher<Models.ProductAdvertisement>(Messaging.Topics.ProductAdvertisement, io, () => [advert]).publish(advert);

var getEnginePublisher = <T>(topic : string) => {
    var wrappedTopic = Messaging.ExchangePairMessaging.wrapExchangePairTopic(gateway.base.exchange(), pair, topic);
    return new Messaging.Publisher<T>(wrappedTopic, io, null, Utils.log("tribeca:messaging"));
};

var quotePublisher = getEnginePublisher<Models.TwoSidedQuote>(Messaging.Topics.Quote);
var fvPublisher = getEnginePublisher(Messaging.Topics.FairValue);
var marketDataPublisher = getEnginePublisher(Messaging.Topics.MarketData);
var orderStatusPublisher = getEnginePublisher(Messaging.Topics.OrderStatusReports);
var tradePublisher = getEnginePublisher(Messaging.Topics.Trades);
var safetySettingsPublisher = getEnginePublisher(Messaging.Topics.SafetySettings);
var activePublisher = getEnginePublisher(Messaging.Topics.ActiveChange);
var quotingParametersPublisher = getEnginePublisher(Messaging.Topics.QuotingParametersChange);
var marketTradePublisher = getEnginePublisher(Messaging.Topics.MarketTrade);
var messagesPublisher = getEnginePublisher(Messaging.Topics.Message);

var messages = new Broker.MessagesPubisher(messagesPublisher);
messages.publish("start up");

var getExchangePublisher = <T>(topic : string) => {
    var wrappedTopic = Messaging.ExchangePairMessaging.wrapExchangeTopic(gateway.base.exchange(), topic);
    return new Messaging.Publisher<T>(wrappedTopic, io, null, messagingLog);
};

var positionPublisher = getExchangePublisher(Messaging.Topics.Position);
var connectivity = getExchangePublisher(Messaging.Topics.ExchangeConnectivity);

var getReciever = <T>(topic : string) => {
    var wrappedTopic = Messaging.ExchangePairMessaging.wrapExchangePairTopic(gateway.base.exchange(), pair, topic);
    return new Messaging.Receiver<T>(wrappedTopic, io, messagingLog);
};

var safetySettingsReceiver = getReciever(Messaging.Topics.SafetySettings);
var activeReceiver = getReciever(Messaging.Topics.ActiveChange);
var quotingParametersReceiver = getReciever(Messaging.Topics.QuotingParametersChange);
var submitOrderReceiver = new Messaging.Receiver(Messaging.Topics.SubmitNewOrder, io, messagingLog);
var cancelOrderReceiver = new Messaging.Receiver(Messaging.Topics.CancelOrder, io, messagingLog);

var db = Persister.loadDb();
var orderPersister = new Persister.OrderStatusPersister(db);
var tradesPersister = new Persister.TradePersister(db);

var broker = new Broker.ExchangeBroker(pair, gateway.md, gateway.base, gateway.oe, gateway.pg, positionPublisher, connectivity);
var orderBroker = new Broker.OrderBroker(broker, gateway.oe, orderPersister, tradesPersister, orderStatusPublisher,
    tradePublisher, submitOrderReceiver, cancelOrderReceiver, app);
var marketDataBroker = new Broker.MarketDataBroker(gateway.md, marketDataPublisher);

var safetyRepo = new Safety.SafetySettingsRepository(safetySettingsPublisher, safetySettingsReceiver);
var safeties = new Safety.SafetySettingsManager(safetyRepo, orderBroker, messages);

var active = new Agent.ActiveRepository(safeties, activePublisher, activeReceiver);
var paramsRepo = new Agent.QuotingParametersRepository(quotingParametersPublisher, quotingParametersReceiver);

var quoter = new Quoter.Quoter(orderBroker, broker);

var quoteGenerator = new Agent.QuoteGenerator(quoter, broker, marketDataBroker, paramsRepo, safeties, quotePublisher, fvPublisher, active);

var marketTradeBroker = new MarketTrades.MarketTradeBroker(gateway.md, marketTradePublisher, marketDataBroker, quoteGenerator);

["uncaughtException", "exit", "SIGINT", "SIGTERM"].forEach(reason => {
    process.on(reason, (e?) => {
        if (!(typeof e === 'undefined') && e.hasOwnProperty('stack'))
            mainLog("Terminating %s :: %s %s", reason, e, e.stack);
        else
            mainLog("Terminating %s [no err/stack]", reason);
        orderBroker.cancelOpenOrders();
        process.exit();
    });
});
