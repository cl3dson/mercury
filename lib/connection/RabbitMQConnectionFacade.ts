import { Channel, connect, Connection, ConsumeMessage } from 'amqplib';
import Message from '../message/Message';
import MessageEmitter from '../messageBus/MessageBusEventEmitter';
import JSONMessage from '../message/JSONMessage';

export default class RabbitMQConnectionFacade {
    private readonly main_bus = 'mercury_bus';
    private connection: Connection;
    private channel: Channel;
    private readonly exchange: string;
    private readonly deadLetterExchange: string;
    private readonly queue: string;
    private readonly retryQueue: string;
    private readonly appName: string;
    private delayRetry: number;

    public constructor(serviceName: string, appName: string, delayRetry: number) {
        this.exchange = serviceName;
        this.deadLetterExchange = `${this.exchange}_dlx`;
        this.queue = `${serviceName}_queue`;
        this.retryQueue = `${this.queue}_retry`;
        this.appName = appName;
        this.delayRetry = delayRetry;
    }

    public async disconnect(): Promise<void> {
        if (this.connection) {
            await this.channel.close();
            await this.connection.close();
            this.connection = undefined;
        }
    }

    public async connect(hostname: string, username: string, password: string): Promise<void> {
        this.connection = await connect({
            protocol: 'amqp',
            hostname,
            port: 5672,
            username,
            password,
        });

        this.channel = await this.connection.createChannel();
        await this.setUp();

        const messagePool = new Map<string, ConsumeMessage>();
        const emitter = MessageEmitter.getMessageEmitter();

        emitter.on(
            MessageEmitter.MESSAGE_PROCESS_ERROR,
            (error: Error, messageId: string, mercuryMessage: Message, maxRetries: number) => {
                const message: ConsumeMessage = messagePool.get(messageId);
                messagePool.delete(messageId);

                maxRetries = maxRetries ? maxRetries : 60;

                if (
                    !message.properties.headers['x-death'] ||
                    (message.properties.headers['x-death'] &&
                        message.properties.headers['x-death'][0].count < maxRetries)
                ) {
                    this.channel.nack(message, false, false);
                } else {
                    this.channel.ack(message);
                }
            },
        );

        emitter.on(MessageEmitter.MESSAGE_PROCESS_SUCCESS, (messageId: string, resultingMessages: Message[]) => {
            this.channel.ack(messagePool.get(messageId));

            if (resultingMessages) {
                for (const message of resultingMessages) {
                    this.publish(message);
                }
            }
            messagePool.delete(messageId);
        });

        emitter.on(MessageEmitter.PROCESS_SUCCESS, (resultingMessages: Message[]) => {
            if (resultingMessages) {
                for (const message of resultingMessages) {
                    this.publish(message);
                }
            }
        });

        this.channel.consume(`${this.queue}`, (msg: ConsumeMessage): void => {
            if (msg.properties.appId === this.appName) {
                if (msg.properties.messageId) {
                    const descriptor = msg.fields.routingKey;

                    messagePool.set(msg.properties.messageId, msg);
                    const message = new JSONMessage(
                        descriptor,
                        msg.content,
                        msg.properties.messageId,
                        msg.properties.timestamp,
                        msg.properties.headers.parentMessage,
                    );
                    emitter.emit(descriptor, message);
                } else {
                    this.channel.ack(msg);
                }
            } else {
                this.channel.ack(msg);
            }
        });
    }

    public publish(message: Message, alternativeExchange: string = null): void {
        const exchange = alternativeExchange ? alternativeExchange : this.main_bus;

        this.channel.publish(exchange, message.getDescriptor(), Buffer.from(message.getSerializedContent()), {
            headers: { parentMessage: message.getParentMessage() },
            persistent: true,
            messageId: message.getUUID(),
            timestamp: new Date().getTime(),
            appId: this.appName,
        });
    }

    public async subscribe(descriptor: string): Promise<void> {
        await this.channel.bindQueue(this.queue, this.exchange, descriptor);
    }

    private async setUp(): Promise<void> {
        /* Creating Exchanges and queues */
        await this.channel.assertExchange(this.main_bus, 'fanout', {
            durable: true,
            autoDelete: false,
        });
        await this.channel.assertExchange(this.exchange, 'direct', {
            durable: true,
            autoDelete: false,
        });
        await this.channel.assertExchange(this.deadLetterExchange, 'fanout', {
            durable: true,
            autoDelete: false,
        });
        await this.channel.assertQueue(this.queue, {
            durable: true,
            autoDelete: false,
            deadLetterExchange: this.deadLetterExchange,
        });
        try {
            await this.channel.assertQueue(this.retryQueue, {
                durable: true,
                autoDelete: false,
                deadLetterExchange: this.exchange,
                arguments: {
                    'x-message-ttl': this.delayRetry * 1000,
                },
            });
        } catch (e) {
            throw e;
        }

        /* Creating the basic bindings */
        await this.channel.bindExchange(this.exchange, this.main_bus, '');
        await this.channel.bindQueue(this.retryQueue, this.deadLetterExchange, '');
    }

    public async subscribeAll(descriptors: string[]): Promise<void> {
        if (Array.isArray(descriptors)) {
            for (const descriptor of descriptors) {
                await this.subscribe(descriptor);
            }
        }
    }
}
